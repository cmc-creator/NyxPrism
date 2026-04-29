import { Router } from 'express';
import pool from '../db/index.js';

const router = Router();

function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: 'ADMIN_SECRET not configured.' });
  if (req.headers['x-admin-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

router.use(requireAdmin);

// ── GET /api/admin/stats ──────────────────────────────────────────────────
router.get('/stats', async (_req, res) => {
  try {
    const [users, plans, keys, messages, unread, recentSignups, subStatus] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total FROM users'),
      pool.query('SELECT plan, COUNT(*) AS count FROM users GROUP BY plan ORDER BY count DESC'),
      pool.query('SELECT COUNT(*) AS total FROM api_keys'),
      pool.query('SELECT COUNT(*) AS total FROM contact_messages'),
      pool.query("SELECT COUNT(*) AS total FROM contact_messages WHERE read = FALSE"),
      pool.query(`SELECT DATE(created_at) AS day, COUNT(*) AS count
                  FROM users WHERE created_at > NOW() - INTERVAL '30 days'
                  GROUP BY day ORDER BY day`),
      pool.query('SELECT subscription_status, COUNT(*) AS count FROM users GROUP BY subscription_status'),
    ]);
    res.json({
      totalUsers:        Number(users.rows[0].total),
      plans:             plans.rows.map(r => ({ plan: r.plan, count: Number(r.count) })),
      totalApiKeys:      Number(keys.rows[0].total),
      totalMessages:     Number(messages.rows[0].total),
      unreadMessages:    Number(unread.rows[0].total),
      recentSignups:     recentSignups.rows.map(r => ({ day: r.day, count: Number(r.count) })),
      subscriptionStats: subStatus.rows.map(r => ({ status: r.subscription_status, count: Number(r.count) })),
    });
  } catch (err) {
    console.error('admin/stats error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// ── GET /api/admin/users?page=1&limit=50&search=&plan=&status= ────────────
router.get('/users', async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(100, parseInt(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  const search = req.query.search?.trim() || '';
  const plan   = req.query.plan?.trim() || '';
  const status = req.query.status?.trim() || '';

  const conditions = [];
  const params     = [];
  if (search) { conditions.push(`(email ILIKE $${params.push('%'+search+'%')} OR first_name ILIKE $${params.push('%'+search+'%')} OR last_name ILIKE $${params.push('%'+search+'%')})`); }
  if (plan)   { conditions.push(`plan = $${params.push(plan)}`); }
  if (status) { conditions.push(`subscription_status = $${params.push(status)}`); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  try {
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT id, email, first_name, last_name, plan, subscription_status,
                trial_active, trial_start, current_period_end, stripe_customer_id,
                stripe_subscription_id, created_at
         FROM users ${where} ORDER BY created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*) AS total FROM users ${where}`, params),
    ]);
    res.json({ users: rows.rows, total: Number(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('admin/users error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// ── PATCH /api/admin/users/:id ────────────────────────────────────────────
router.patch('/users/:id', async (req, res) => {
  const { plan, subscription_status, trial_active } = req.body || {};
  const sets = [];
  const params = [];
  if (plan !== undefined)                { sets.push(`plan = $${params.push(plan)}`); }
  if (subscription_status !== undefined) { sets.push(`subscription_status = $${params.push(subscription_status)}`); }
  if (trial_active !== undefined)        { sets.push(`trial_active = $${params.push(trial_active)}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  sets.push(`updated_at = NOW()`);
  try {
    const result = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.push(req.params.id)} RETURNING id, email, plan, subscription_status, trial_active`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('admin/users PATCH error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────
router.delete('/users/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id, email', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found.' });
    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('admin/users DELETE error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// ── GET /api/admin/api-keys?page=1&limit=50 ───────────────────────────────
router.get('/api-keys', async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page) || 1);
  const limit  = Math.min(100, parseInt(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  try {
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT k.id, k.label, k.key_prefix, k.created_at, k.last_used_at,
                u.id AS user_id, u.email, u.plan
         FROM api_keys k JOIN users u ON k.user_id = u.id
         ORDER BY k.created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query('SELECT COUNT(*) AS total FROM api_keys'),
    ]);
    res.json({ keys: rows.rows, total: Number(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('admin/api-keys error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// ── DELETE /api/admin/api-keys/:id ────────────────────────────────────────
router.delete('/api-keys/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM api_keys WHERE id = $1 RETURNING id, key_prefix', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Key not found.' });
    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('admin/api-keys DELETE error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// ── GET /api/admin/messages?page=1&limit=20&unread= ──────────────────────
router.get('/messages', async (req, res) => {
  const page    = Math.max(1, parseInt(req.query.page) || 1);
  const limit   = Math.min(100, parseInt(req.query.limit) || 20);
  const offset  = (page - 1) * limit;
  const unread  = req.query.unread === 'true';
  const where   = unread ? 'WHERE read = FALSE' : '';
  try {
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT id, first_name, last_name, email, subject, message, read, created_at
         FROM contact_messages ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query(`SELECT COUNT(*) AS total FROM contact_messages ${where}`),
    ]);
    res.json({ messages: rows.rows, total: Number(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('admin/messages error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// ── PATCH /api/admin/messages/:id/read ───────────────────────────────────
router.patch('/messages/:id/read', async (req, res) => {
  try {
    await pool.query('UPDATE contact_messages SET read = TRUE WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error.' });
  }
});

export default router;
