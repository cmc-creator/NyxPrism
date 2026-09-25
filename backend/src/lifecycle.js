// Lifecycle emails: welcome, trial reminders and a one-time upgrade nudge.
// Each kind is sent at most once per user (lifecycle_emails), and every email
// carries a one-click unsubscribe link that sets users.marketing_opt_out.
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import pool from './db/index.js';
import { isDeveloper } from './access.js';

const APP = () => (process.env.FRONTEND_URL || 'https://www.nyxprism.com').replace(/\/$/, '');
const API = () => (process.env.PUBLIC_API_URL || 'https://nyxprism-production.up.railway.app').replace(/\/$/, '');
const TRIAL_DAYS = 14;

function secret() {
  return process.env.EMAIL_LINK_SECRET || createHash('sha256').update(`nyxprism-email:${process.env.DATABASE_URL || ''}`).digest('hex');
}

export function unsubscribeToken(userId) {
  return createHmac('sha256', secret()).update(`unsubscribe:${userId}`).digest('hex').slice(0, 32);
}

export function verifyUnsubscribeToken(userId, token) {
  const expected = Buffer.from(unsubscribeToken(userId));
  const given = Buffer.from(String(token || ''));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function layout(userId, { heading, paragraphs, cta }) {
  const unsubscribe = `${API()}/api/user/unsubscribe?u=${userId}&t=${unsubscribeToken(userId)}`;
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111827;line-height:1.6">
  <p style="font-size:20px;font-weight:800;margin:0 0 16px"><span style="color:#7c3aed">Nyx</span>Prism</p>
  <h1 style="font-size:22px;margin:0 0 12px">${escapeHtml(heading)}</h1>
  ${paragraphs.map(p => `<p style="margin:0 0 12px">${p}</p>`).join('')}
  ${cta ? `<p style="margin:20px 0"><a href="${cta.href}" style="background:#7c3aed;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700">${escapeHtml(cta.label)}</a></p>` : ''}
  <p style="font-size:12px;color:#6b7280;margin-top:28px">You're receiving this because you have a NyxPrism account.
  <a href="${unsubscribe}" style="color:#6b7280">Unsubscribe from these emails</a>.</p>
</div>`;
}

async function sendBrevo({ to, subject, html }) {
  if (!process.env.BREVO_API_KEY) throw new Error('BREVO_API_KEY is not configured.');
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: { name: 'NyxPrism', email: 'noreply@nyxprism.com' }, to: [{ email: to }], subject, htmlContent: html }),
  });
  if (!res.ok) throw new Error(`Brevo error ${res.status}`);
}

const TEMPLATES = {
  welcome: user => ({
    subject: 'Welcome to NyxPrism',
    heading: `Welcome${user.first_name ? `, ${user.first_name}` : ''}!`,
    paragraphs: [
      'Your NyxPrism account is ready. Split, merge, compress and convert PDFs right in your browser - your files stay with you.',
      'Professional adds AI Smart Split, e-signature requests with a certificate of completion, tracked document sending, and more.',
    ],
    cta: { label: 'Open NyxPrism', href: `${APP()}/dashboard.html` },
  }),
  trial_3d: () => ({
    subject: 'Your NyxPrism trial ends in 3 days',
    heading: 'Your trial ends in 3 days',
    paragraphs: [
      'Keep AI Smart Split, signature requests and tracked sending by subscribing before your trial ends - $12/month, or $99/year.',
      "If you don't, nothing is lost: your account moves to the free tools.",
    ],
    cta: { label: 'Keep Professional', href: `${APP()}/dashboard.html#account` },
  }),
  trial_ended: () => ({
    subject: 'Your NyxPrism trial has ended',
    heading: 'Your trial has ended',
    paragraphs: [
      'Your account is now on the free plan, and all the free PDF tools still work.',
      'Upgrade any time to get AI Smart Split, signature requests and tracked sending back.',
    ],
    cta: { label: 'Upgrade to Professional', href: `${APP()}/dashboard.html#account` },
  }),
  pro_nudge: () => ({
    subject: 'Unlock the rest of NyxPrism',
    heading: 'That feature is part of Professional',
    paragraphs: [
      'You just tried a Professional feature. Professional includes AI Smart Split and document analysis, e-signature requests, tracked sending to up to 250 people, and API access.',
      '$12/month, or $99/year - cancel any time.',
    ],
    cta: { label: 'See Professional', href: `${APP()}/dashboard.html#account` },
  }),
};

/** Send one lifecycle email unless it was already sent, the user opted out, or it's an internal account. */
export async function sendLifecycleEmail(userId, kind) {
  const { rows } = await pool.query('SELECT id, email, first_name, marketing_opt_out FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user || user.marketing_opt_out || isDeveloper(user.email) || !TEMPLATES[kind]) return false;
  const claimed = await pool.query(
    'INSERT INTO lifecycle_emails (user_id, kind) VALUES ($1, $2) ON CONFLICT (user_id, kind) DO NOTHING RETURNING user_id',
    [userId, kind],
  );
  if (!claimed.rows.length) return false;
  const t = TEMPLATES[kind](user);
  try {
    await sendBrevo({ to: user.email, subject: t.subject, html: layout(user.id, t) });
    return true;
  } catch (err) {
    // Release the claim so the next run can retry.
    await pool.query('DELETE FROM lifecycle_emails WHERE user_id = $1 AND kind = $2', [userId, kind]).catch(() => {});
    console.error(`Lifecycle email ${kind} failed:`, err.message);
    return false;
  }
}

/** Trial reminders; safe to run repeatedly (each email goes out once). */
export async function runLifecycleJobs() {
  const endingSoon = await pool.query(
    `SELECT id FROM users WHERE plan = 'trial' AND trial_start IS NOT NULL
       AND trial_start <= NOW() - INTERVAL '${TRIAL_DAYS - 3} days' AND trial_start > NOW() - INTERVAL '${TRIAL_DAYS} days'`,
  );
  const ended = await pool.query(
    `SELECT id FROM users WHERE plan = 'trial' AND trial_start IS NOT NULL
       AND trial_start <= NOW() - INTERVAL '${TRIAL_DAYS} days' AND trial_start > NOW() - INTERVAL '${TRIAL_DAYS + 30} days'`,
  );
  let sent = 0;
  for (const row of endingSoon.rows) if (await sendLifecycleEmail(row.id, 'trial_3d')) sent++;
  for (const row of ended.rows) if (await sendLifecycleEmail(row.id, 'trial_ended')) sent++;
  return sent;
}
