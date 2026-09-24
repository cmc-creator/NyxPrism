import express from 'express';
import pool from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import Stripe from 'stripe';
import admin from '../firebase.js';
import { developerEntitlements, isOwner } from '../access.js';

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
    await pool.query(
      `INSERT INTO users (firebase_uid, email, first_name, last_name, plan, subscription_status, trial_active, trial_start)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (email) DO UPDATE SET
         -- Only a verified owner of the address may take over an existing row.
         firebase_uid = CASE WHEN $9 OR users.firebase_uid = EXCLUDED.firebase_uid THEN EXCLUDED.firebase_uid ELSE users.firebase_uid END,
         first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), users.first_name),
         last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), users.last_name),
         updated_at = NOW()`,
          [uid, email, String(firstName || '').slice(0, 100) || null, String(lastName || '').slice(0, 100) || null,
            accountPlan, subscriptionStatus, accountPlan === 'trial', accountPlan === 'trial' ? new Date() : null,
            Boolean(req.user.email_verified)],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('User sync error:', err);
    res.status(500).json({ error: 'Failed to sync user.' });
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

    // Firebase is the source of truth for email — reconcile after an email change.
    if (req.user.email && account.email.toLowerCase() !== req.user.email.toLowerCase()) {
      try {
        await pool.query('UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2', [req.user.email, account.id]);
        account.email = req.user.email;
      } catch (_) { /* unique-email conflict: keep the stored address */ }
    }

    const { id: _id, ...publicAccount } = account;
    res.json({ ...publicAccount, firebase_uid: req.user.uid, ...(developer || {}) });
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
