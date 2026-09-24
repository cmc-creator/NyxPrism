import express from 'express';
import pool from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { developerEntitlements } from '../access.js';

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
         firebase_uid = EXCLUDED.firebase_uid,
         first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), users.first_name),
         last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), users.last_name),
         updated_at = NOW()`,
          [uid, email, String(firstName || '').slice(0, 100) || null, String(lastName || '').slice(0, 100) || null,
            accountPlan, subscriptionStatus, accountPlan === 'trial', accountPlan === 'trial' ? new Date() : null],
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

    const { id: _id, ...publicAccount } = account;
    res.json({ ...publicAccount, firebase_uid: req.user.uid, ...(developer || {}) });
  } catch (err) {
    console.error('User /me error:', err);
    res.status(500).json({ error: 'Internal error.' });
  }
});

export default router;
