import express from 'express';
import pool from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import Stripe from 'stripe';
import admin from '../firebase.js';
import { developerEntitlements, isOwner } from '../access.js';
import { sendLifecycleEmail, verifyUnsubscribeToken } from '../lifecycle.js';
import { activeTeamFor } from '../teams.js';

const router = express.Router();

// ── POST /api/user/sync ──────────────────────────────────────────────────
// Called by the frontend immediately after Firebase createUserWithEmailAndPassword.
// Creates the Postgres user row if it doesn't exist yet.
router.post('/sync', requireAuth, async (req, res) => {
  const { uid, email } = req.user;
  const { firstName, lastName, plan } = req.body ?? {};
  const accountPlan = plan === 'trial' ? 'trial' : 'free';
  const subscriptionStatus = accountPlan === 'trial' ? 'trialing' : 'active';

  try {
    const result = await pool.query(
      `INSERT INTO users (firebase_uid, email, first_name, last_name, plan, subscription_status, trial_active, trial_start)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (email) DO UPDATE SET
         -- Only a verified owner of the address may take over an existing row.
         firebase_uid = CASE WHEN $9 OR users.firebase_uid = EXCLUDED.firebase_uid THEN EXCLUDED.firebase_uid ELSE users.firebase_uid END,
         first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), users.first_name),
         last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), users.last_name),
         updated_at = NOW()
       RETURNING id, (xmax = 0) AS inserted`,
          [uid, email, String(firstName || '').slice(0, 100) || null, String(lastName || '').slice(0, 100) || null,
            accountPlan, subscriptionStatus, accountPlan === 'trial', accountPlan === 'trial' ? new Date() : null,
            Boolean(req.user.email_verified)],
    );
    const row = result.rows[0];
    if (row?.inserted) sendLifecycleEmail(row.id, 'welcome').catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error('User sync error:', err);
    res.status(500).json({ error: 'Failed to sync user.' });
  }
});

// ── GET /api/user/unsubscribe?u=<id>&t=<token> ────────────────────────────
// One-click unsubscribe from lifecycle emails (link in every email footer).
router.get('/unsubscribe', async (req, res) => {
  const id = parseInt(req.query.u, 10);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!Number.isInteger(id) || !verifyUnsubscribeToken(id, req.query.t)) {
    return res.status(400).send('<!DOCTYPE html><title>NyxPrism</title><h1>This unsubscribe link is not valid.</h1><p>Contact info@nyxprism.com and we will remove you.</p>');
  }
  try {
    await pool.query('UPDATE users SET marketing_opt_out = TRUE, updated_at = NOW() WHERE id = $1', [id]);
    res.send("<!DOCTYPE html><title>Unsubscribed · NyxPrism</title><h1>You're unsubscribed.</h1><p>You won't receive NyxPrism tips or trial reminders. Account and security emails (like password resets and signature requests) still arrive.</p><p><a href='https://www.nyxprism.com/'>Back to NyxPrism</a></p>");
  } catch (err) {
    console.error('Unsubscribe error:', err.message);
    res.status(500).send('<!DOCTYPE html><title>NyxPrism</title><h1>Something went wrong.</h1><p>Please try the link again.</p>');
  }
});

// ── GET /api/user/me ─────────────────────────────────────────────────────
// Returns the authenticated user's subscription details.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const developer = developerEntitlements(req.user.email);
    let { rows } = await pool.query(
      `SELECT id, firebase_uid, email, first_name, last_name, plan,
              subscription_status, trial_active, trial_start,
              current_period_end, created_at
       FROM users
       WHERE firebase_uid = $1 OR LOWER(email) = LOWER($2)
       ORDER BY (firebase_uid = $1) DESC
       LIMIT 1`,
      [req.user.uid, req.user.email],
    );

    if (!rows.length) {
      const created = await pool.query(
        `INSERT INTO users (firebase_uid, email, plan, subscription_status, trial_active, trial_start)
         VALUES ($1, $2, $3, $4, FALSE, NULL)
         RETURNING id, firebase_uid, email, first_name, last_name, plan,
                   subscription_status, trial_active, trial_start,
                   current_period_end, created_at`,
        [req.user.uid, req.user.email, developer ? 'professional' : 'free', 'active'],
      );
      rows = created.rows;
    }

    const account = rows[0];
    // Re-linking a row created under another login requires a verified email.
    const mayRelink = account.firebase_uid === req.user.uid || req.user.email_verified || developer;
    if (!mayRelink) return res.status(403).json({ error: 'Verify your email address to access this account.', code: 'email_unverified' });
    if (account.firebase_uid !== req.user.uid || developer) {
      await pool.query(
        `UPDATE users SET firebase_uid = $1,
           plan = CASE WHEN $3 THEN 'professional' ELSE plan END,
           subscription_status = CASE WHEN $3 THEN 'active' ELSE subscription_status END,
           trial_active = CASE WHEN $3 THEN FALSE ELSE trial_active END,
           updated_at = NOW()
         WHERE id = $2`,
        [req.user.uid, account.id, Boolean(developer)],
      );
    }

    // Firebase is the source of truth for email - reconcile after an email change.
    if (req.user.email && account.email.toLowerCase() !== req.user.email.toLowerCase()) {
      try {
        await pool.query('UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2', [req.user.email, account.id]);
        account.email = req.user.email;
      } catch (_) { /* unique-email conflict: keep the stored address */ }
    }

    const { id: accountId, ...publicAccount } = account;
    // Members of a team get Professional through the team owner's plan.
    const team = developer ? null : await activeTeamFor(accountId).catch(() => null);
    const teamPlan = team && publicAccount.plan !== 'professional'
      ? { plan: 'professional', subscription_status: 'active', trial_active: false, trial_start: null } : {};
    res.json({ ...publicAccount, firebase_uid: req.user.uid, ...teamPlan, ...(developer || {}), team: team ? { name: team.name, role: team.role } : null });
  } catch (err) {
    console.error('User /me error:', err);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// ── POST /api/user/profile ───────────────────────────────────────────────
// Updates the authenticated user's first and last name.
router.post('/profile', requireAuth, async (req, res) => {
  const firstName = String(req.body?.firstName || '').trim().slice(0, 100);
  const lastName = String(req.body?.lastName || '').trim().slice(0, 100);
  if (!firstName) return res.status(400).json({ error: 'First name is required.' });
  try {
    const result = await pool.query(
      `UPDATE users SET first_name = $1, last_name = $2, updated_at = NOW()
       WHERE firebase_uid = $3 OR LOWER(email) = LOWER($4)
       RETURNING first_name, last_name`,
      [firstName, lastName || null, req.user.uid, req.user.email],
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Account not found.' });
    res.json({ ok: true, firstName: result.rows[0].first_name, lastName: result.rows[0].last_name || '' });
  } catch (err) {
    console.error('User profile error:', err);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

async function accountRow(user) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE firebase_uid = $1 OR LOWER(email) = LOWER($2) ORDER BY (firebase_uid = $1) DESC LIMIT 1',
    [user.uid, user.email],
  );
  return rows[0] || null;
}


// ── Branding: company name and logo on signing emails and the signing page ──
const LOGO_TYPES = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff] };
const MAX_LOGO_BYTES = 200 * 1024;

router.get('/brand', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, brand_name, (brand_logo IS NOT NULL) AS has_logo FROM users WHERE firebase_uid = $1 OR LOWER(email) = LOWER($2) LIMIT 1',
      [req.user.uid, req.user.email],
    );
    const row = rows[0];
    res.json({ name: row?.brand_name || '', logoUrl: row?.has_logo ? `/api/user/brand/${row.id}/logo?v=${Date.now()}` : null });
  } catch (err) {
    console.error('Brand get error:', err.message);
    res.status(500).json({ error: 'Failed to load branding.' });
  }
});

// POST /api/user/brand  { name, logo: "data:image/png;base64,..." | null (remove) | undefined (keep) }
router.post('/brand', requireAuth, async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80) || null;
  let logo; let logoType;
  if (req.body?.logo === null) { logo = null; logoType = null; }
  else if (typeof req.body?.logo === 'string') {
    const match = req.body.logo.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return res.status(400).json({ error: 'The logo must be a PNG or JPG image.' });
    const bytes = Buffer.from(match[2], 'base64');
    const magic = LOGO_TYPES[match[1]];
    if (!magic.every((b, i) => bytes[i] === b)) return res.status(400).json({ error: 'The logo must be a PNG or JPG image.' });
    if (bytes.length > MAX_LOGO_BYTES) return res.status(400).json({ error: 'The logo must be 200 KB or smaller.' });
    logo = bytes; logoType = match[1];
  }
  try {
    const sets = ['brand_name = $1', 'updated_at = NOW()'];
    const params = [name];
    if (logo !== undefined) { params.push(logo, logoType); sets.push(`brand_logo = $${params.length - 1}`, `brand_logo_type = $${params.length}`); }
    params.push(req.user.uid, req.user.email);
    const { rowCount } = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE firebase_uid = $${params.length - 1} OR LOWER(email) = LOWER($${params.length})`,
      params,
    );
    if (!rowCount) return res.status(404).json({ error: 'Account not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Brand save error:', err.message);
    res.status(500).json({ error: 'Failed to save branding.' });
  }
});

// Public: the logo image, used in emails and on signing pages.
router.get('/brand/:id/logo', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).end();
  try {
    const { rows } = await pool.query('SELECT brand_logo, brand_logo_type FROM users WHERE id = $1 AND brand_logo IS NOT NULL', [id]);
    if (!rows.length) return res.status(404).end();
    res.setHeader('Content-Type', rows[0].brand_logo_type || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(Buffer.from(rows[0].brand_logo));
  } catch (err) {
    console.error('Brand logo error:', err.message);
    res.status(500).end();
  }
});

// ── GET /api/user/export ─────────────────────────────────────────────────
// Everything NyxPrism stores about the account, as JSON (document files excluded).
router.get('/export', requireAuth, async (req, res) => {
  try {
    const account = await accountRow(req.user);
    if (!account) return res.status(404).json({ error: 'Account not found.' });
    const [contacts, signRequests, recipients, distributions, apiKeys] = await Promise.all([
      pool.query('SELECT name, email, last_used_at, created_at FROM saved_contacts WHERE user_id = $1 ORDER BY name', [account.id]),
      pool.query(`SELECT id, title, document_name, document_size, document_hash, message, status, created_at, sent_at, completed_at, expires_at
                  FROM signature_requests WHERE owner_user_id = $1 ORDER BY created_at DESC`, [account.id]),
      pool.query(`SELECT sr.request_id, sr.name, sr.email, sr.status, sr.viewed_at, sr.completed_at, sr.declined_at
                  FROM signature_recipients sr JOIN signature_requests r ON r.id = sr.request_id
                  WHERE r.owner_user_id = $1 ORDER BY sr.request_id, sr.role_order`, [account.id]),
      pool.query(`SELECT b.id, b.title, b.document_name, b.status, b.created_at, b.sent_at, b.expires_at,
                         COALESCE(json_agg(json_build_object('name', d.name, 'email', d.email, 'status', d.status, 'opened_at', d.opened_at))
                                  FILTER (WHERE d.id IS NOT NULL), '[]') AS recipients
                  FROM distribution_batches b LEFT JOIN distribution_recipients d ON d.batch_id = b.id
                  WHERE b.owner_user_id = $1 GROUP BY b.id ORDER BY b.created_at DESC`, [account.id]),
      pool.query('SELECT label, key_prefix, created_at, last_used_at FROM api_keys WHERE user_id = $1 ORDER BY created_at', [account.id]),
    ]);
    const recipientsByRequest = new Map();
    for (const row of recipients.rows) {
      const { request_id: requestId, ...rest } = row;
      if (!recipientsByRequest.has(requestId)) recipientsByRequest.set(requestId, []);
      recipientsByRequest.get(requestId).push(rest);
    }
    res.setHeader('Content-Disposition', 'attachment; filename="nyxprism-my-data.json"');
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      exportedAt: new Date().toISOString(),
      account: {
        email: account.email, firstName: account.first_name, lastName: account.last_name,
        plan: account.plan, subscriptionStatus: account.subscription_status,
        trialStart: account.trial_start, currentPeriodEnd: account.current_period_end, createdAt: account.created_at,
      },
      savedContacts: contacts.rows,
      signatureRequests: signRequests.rows.map(r => ({ ...r, recipients: recipientsByRequest.get(r.id) || [] })),
      distributions: distributions.rows,
      apiKeys: apiKeys.rows,
      note: 'Document files are not included. Download completed documents from the dashboard.',
    });
  } catch (err) {
    console.error('User export error:', err.message);
    res.status(500).json({ error: 'Failed to export your data.' });
  }
});

// ── DELETE /api/user/account  { confirmEmail } ───────────────────────────
// Cancels any subscription, deletes the login and every row the account owns.
router.delete('/account', requireAuth, async (req, res) => {
  const email = String(req.user.email || '').toLowerCase();
  if (String(req.body?.confirmEmail || '').trim().toLowerCase() !== email) {
    return res.status(400).json({ error: 'Type your email address exactly to confirm.' });
  }
  if (isOwner(email)) return res.status(400).json({ error: 'The owner account cannot be deleted here.' });
  try {
    const account = await accountRow(req.user);
    if (account?.stripe_subscription_id && process.env.STRIPE_SECRET_KEY) {
      try {
        await new Stripe(process.env.STRIPE_SECRET_KEY).subscriptions.cancel(account.stripe_subscription_id);
      } catch (err) {
        if (err?.code !== 'resource_missing') throw err;
      }
    }
    if (account) await pool.query('DELETE FROM users WHERE id = $1', [account.id]);
    await pool.query('DELETE FROM ai_usage WHERE firebase_uid = $1', [req.user.uid]).catch(() => {});
    try {
      const { getFirestore } = await import('firebase-admin/firestore');
      await getFirestore().doc(`users/${req.user.uid}`).delete();
    } catch (err) {
      console.warn('Firestore profile delete skipped:', err.message);
    }
    await admin.auth().deleteUser(req.user.uid);
    res.json({ ok: true });
  } catch (err) {
    console.error('Account delete error:', err.message);
    res.status(500).json({ error: 'Could not delete your account. Please contact support.' });
  }
});

export default router;
