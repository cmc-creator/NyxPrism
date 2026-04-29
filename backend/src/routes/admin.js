import { Router } from 'express';
import pool from '../db/index.js';
import admin from '../firebase.js';

const router = Router();

// ── Auth middleware: verify Firebase ID token + is_admin flag ─────────────
async function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Firebase token.' });
  }
  const token = auth.slice(7);
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const result  = await pool.query(
      'SELECT id, email, is_admin FROM users WHERE firebase_uid = $1',
      [decoded.uid]
    );
    const user = result.rows[0];
    if (!user?.is_admin) {
      return res.status(403).json({ error: 'Not an admin.' });
    }
    req.adminUser = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// ── POST /api/admin/claim ─────────────────────────────────────────────────
// One-time: present Firebase token + ADMIN_SECRET → grants is_admin = true
// Matches by firebase_uid OR email so existing accounts without firebase_uid work.
router.post('/claim', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: 'ADMIN_SECRET not configured.' });

  const provided = req.body?.secret;
  if (!provided || provided !== secret) {
    return res.status(401).json({ error: 'Wrong secret.' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Firebase token.' });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const result  = await pool.query(
      `UPDATE users
       SET is_admin = TRUE, firebase_uid = $1
       WHERE firebase_uid = $1 OR email = $2
       RETURNING email`,
      [decoded.uid, decoded.email]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'No NyxPrism account found for that email. Sign up first at nyxprism.com.' });
    }
    res.json({ ok: true, email: result.rows[0].email });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
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
