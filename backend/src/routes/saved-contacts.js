import { Router } from 'express';
import pool from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

async function findOrCreateUser(user) {
  const existing = await pool.query(
    'SELECT id FROM users WHERE firebase_uid = $1 OR LOWER(email) = LOWER($2) LIMIT 1',
    [user.uid, user.email],
  );
  if (existing.rows.length) return existing.rows[0].id;
  const created = await pool.query(
    `INSERT INTO users (firebase_uid, email, plan, subscription_status, trial_start)
     VALUES ($1, $2, 'trial', 'trialing', NOW())
     ON CONFLICT (email) DO UPDATE SET firebase_uid = EXCLUDED.firebase_uid
     RETURNING id`,
    [user.uid, user.email],
  );
  return created.rows[0].id;
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = await findOrCreateUser(req.user);
    const result = await pool.query(
      `SELECT id, name, email, last_used_at
       FROM saved_contacts
       WHERE user_id = $1
       ORDER BY last_used_at DESC, name ASC
       LIMIT 500`,
      [userId],
    );
    res.json({ contacts: result.rows });
  } catch (err) {
    console.error('saved-contacts GET error:', err.message);
    res.status(500).json({ error: 'Failed to load saved people.' });
  }
});

export default router;