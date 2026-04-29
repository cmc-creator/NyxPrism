import { Router } from 'express';
import pool from '../db/index.js';

const router = Router();

// All admin routes require x-admin-secret header matching ADMIN_SECRET env var
function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: 'ADMIN_SECRET not configured.' });
  if (req.headers['x-admin-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

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
                trial_active, trial_start, current_period_end, created_at
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
