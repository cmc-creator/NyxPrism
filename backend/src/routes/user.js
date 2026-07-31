import express from 'express';
import pool from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// ── POST /api/user/sync ──────────────────────────────────────────────────
// Called by the frontend immediately after Firebase createUserWithEmailAndPassword.
// Creates the Postgres user row if it doesn't exist yet.
router.post('/sync', requireAuth, async (req, res) => {
  const { uid, email } = req.user;
  const { firstName, lastName } = req.body ?? {};

  try {
    await pool.query(
      `INSERT INTO users (firebase_uid, email, first_name, last_name, plan, trial_start)
      VALUES ($1, $2, $3, $4, 'trial', NOW())
       ON CONFLICT (firebase_uid) DO NOTHING`,
          [uid, email, String(firstName || '').slice(0, 100) || null, String(lastName || '').slice(0, 100) || null],
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
    const { rows } = await pool.query(
      `SELECT firebase_uid, email, first_name, last_name, plan,
              subscription_status, trial_active, trial_start,
              current_period_end, created_at
       FROM users WHERE firebase_uid = $1`,
      [req.user.uid],
    );

    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('User /me error:', err);
    res.status(500).json({ error: 'Internal error.' });
  }
});

export default router;
