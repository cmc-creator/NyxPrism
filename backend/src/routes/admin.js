import { Router } from 'express';
import pool from '../db/index.js';
import admin from '../firebase.js';

const router = Router();

// ── Auth middleware ───────────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Firebase token.' });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const result = await pool.query(
      `SELECT id, email, is_admin FROM users WHERE firebase_uid = $1 OR email = $2 LIMIT 1`,
      [decoded.uid, decoded.email]
    );
    const user = result.rows[0];
    if (!user?.is_admin) {
      return res.status(403).json({ error: 'Not an admin.' });
    }
    // Backfill firebase_uid if missing
    pool.query(
      `UPDATE users SET firebase_uid = $1 WHERE email = $2 AND (firebase_uid IS NULL OR firebase_uid != $1)`,
      [decoded.uid, decoded.email]
    ).catch(() => {});
    req.adminUser = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// ── POST /api/admin/claim ─────────────────────────────────────────────────
// One-time bootstrap: only needs ADMIN_SECRET + email in the body.
// No Firebase token required — avoids all uid/row-mismatch issues.
router.post('/claim', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: 'ADMIN_SECRET not configured on server.' });

  const { secret: provided, email } = req.body || {};
  if (!provided || provided !== secret) {
    return res.status(401).json({ error: 'Wrong secret.' });
  }
  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  const normalised = email.toLowerCase().trim();
  try {
    // Try to update an existing row first
    let result = await pool.query(
      `UPDATE users SET is_admin = TRUE WHERE email = $1 RETURNING email`,
      [normalised]
    );
    // No row yet — insert one (e.g. owner hasn't gone through normal signup)
    if (!result.rows.length) {
      result = await pool.query(
        `INSERT INTO users (firebase_uid, email, plan, subscription_status, trial_start, is_admin)
         VALUES ('bootstrap-' || gen_random_uuid(), $1, 'trial', 'trialing', NOW(), TRUE)
         ON CONFLICT (email) DO UPDATE SET is_admin = TRUE
         RETURNING email`,
        [normalised]
      );
    }
    res.json({ ok: true, email: result.rows[0]?.email || normalised });
  } catch (err) {
    console.error('admin/claim error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// All routes below require admin auth
router.use(requireAdmin);

// GET /api/admin/stats
router.get('/stats', async (_req, res) => {
  try {
    const [users, plans, keys, messages] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total FROM users'),
      pool.query('SELECT plan, COUNT(*) AS count FROM users GROUP BY plan ORDER BY count DESC'),
      pool.query('SELECT COUNT(*) AS total FROM api_keys'),
      pool.query('SELECT COUNT(*) AS total FROM contact_messages'),
    ]);
    res.json({
      totalUsers:    Number(users.rows[0].total),
      plans:         plans.rows.map(r => ({ plan: r.plan, count: Number(r.count) })),
      totalApiKeys:  Number(keys.rows[0].total),
      totalMessages: Number(messages.rows[0].total),
    });
  } catch (err) {
    console.error('admin/stats error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// GET /api/admin/users?page=1&limit=50
router.get('/users', async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  try {
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT id, email, first_name, last_name, plan, subscription_status,
                trial_active, trial_start, current_period_end, is_admin, created_at
         FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query('SELECT COUNT(*) AS total FROM users'),
    ]);
    res.json({ users: rows.rows, total: Number(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('admin/users error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// GET /api/admin/messages?page=1&limit=20
router.get('/messages', async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  try {
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT id, first_name, last_name, email, subject, message, read, created_at
         FROM contact_messages ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query('SELECT COUNT(*) AS total FROM contact_messages'),
    ]);
    res.json({ messages: rows.rows, total: Number(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('admin/messages error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

export default router;
