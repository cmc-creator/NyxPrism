import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import pool from '../db/index.js';
import admin from '../firebase.js';
import Stripe from 'stripe';
import { isOwner, isDeveloper } from '../access.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const adminAuthLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  // Only failed authentication counts toward the limit, so validation errors
  // or not-found results during normal admin work never lock the owner out.
  requestWasSuccessful: (_req, res) => res.statusCode !== 401 && res.statusCode !== 403,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin authentication attempts. Try again later.' },
});

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
    const owner = isOwner(decoded.email);
    if (!owner && !user?.is_admin) {
      return res.status(403).json({ error: 'Not an admin.' });
    }
    // Backfill firebase_uid if missing
    if (user) pool.query(
      `UPDATE users SET firebase_uid = $1 WHERE email = $2 AND (firebase_uid IS NULL OR firebase_uid != $1)`,
      [decoded.uid, decoded.email]
    ).catch(() => {});
    req.adminUser = { ...(user || {}), email: decoded.email, uid: decoded.uid, auth: owner ? 'owner' : 'admin', owner };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// All routes below require admin auth. Failed attempts are limited; normal
// admin work (including 4xx validation results) never counts toward the limit.
router.use(adminAuthLimiter, requireAdmin);

const PLANS = ['free', 'trial', 'professional', 'inactive'];
const STATUSES = ['active', 'trialing', 'past_due', 'canceled', 'inactive'];

async function audit(req, action, target, detail) {
  try {
    await pool.query(
      'INSERT INTO admin_audit_log (actor, action, target, detail) VALUES ($1, $2, $3, $4)',
      [req.adminUser?.email || 'unknown', action, target || null, detail ? String(detail).slice(0, 1000) : null]
    );
  } catch (err) {
    console.error('admin audit error:', err.message);
  }
}

function requireOwner(req, res, next) {
  if (req.adminUser?.owner) return next();
  res.status(403).json({ error: 'Only the owner can do that.' });
}

function firebaseSummary(record) {
  if (!record) return null;
  return {
    uid: record.uid,
    disabled: record.disabled,
    emailVerified: record.emailVerified,
    createdAt: record.metadata?.creationTime || null,
    lastSignInAt: record.metadata?.lastSignInTime || null,
    lastActiveAt: record.metadata?.lastRefreshTime || null,
    providers: (record.providerData || []).map(p => p.providerId),
  };
}

async function firebaseByUid(uids) {
  const map = new Map();
  const ids = uids.filter(uid => uid && !uid.startsWith('bootstrap-'));
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const result = await admin.auth().getUsers(ids.slice(i, i + 100).map(uid => ({ uid })));
      result.users.forEach(u => map.set(u.uid, firebaseSummary(u)));
    } catch (err) {
      console.error('admin firebase lookup error:', err.message);
    }
  }
  return map;
}

async function loadUser(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function firebaseRecordFor(user) {
  try {
    return await admin.auth().getUserByEmail(user.email);
  } catch (err) {
    if (err?.code === 'auth/user-not-found') return null;
    throw err;
  }
}

function userId(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: 'Invalid user id.' }); return null; }
  return id;
}

// GET /api/admin/me
router.get('/me', (req, res) => {
  res.json({ email: req.adminUser.email, auth: req.adminUser.auth, owner: !!req.adminUser.owner });
});

// GET /api/admin/stats
router.get('/stats', async (_req, res) => {
  try {
    const [users, plans, keys, messages, unread, recent, daily, signReqs, dists, trials, funnel] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total FROM users'),
      pool.query('SELECT plan, COUNT(*) AS count FROM users GROUP BY plan ORDER BY count DESC'),
      pool.query('SELECT COUNT(*) AS total FROM api_keys'),
      pool.query('SELECT COUNT(*) AS total FROM contact_messages'),
      pool.query('SELECT COUNT(*) AS total FROM contact_messages WHERE read = FALSE'),
      pool.query(`SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS week,
                         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') AS month
                  FROM users`),
      pool.query(`SELECT to_char(d, 'YYYY-MM-DD') AS day, COUNT(u.id) AS count
                  FROM generate_series(date_trunc('day', NOW()) - INTERVAL '29 days', date_trunc('day', NOW()), INTERVAL '1 day') d
                  LEFT JOIN users u ON date_trunc('day', u.created_at) = d
                  GROUP BY d ORDER BY d`),
      pool.query('SELECT status, COUNT(*) AS count FROM signature_requests GROUP BY status'),
      pool.query('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE sent_at IS NOT NULL) AS sent FROM distribution_batches'),
      pool.query('SELECT COUNT(*) AS total FROM users WHERE trial_active = TRUE'),
      pool.query(`SELECT
          COUNT(*) AS signed_up,
          COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM lifecycle_emails e WHERE e.user_id = u.id AND e.kind = 'pro_nudge')) AS tried_pro,
          COUNT(*) FILTER (WHERE u.trial_start IS NOT NULL) AS trials,
          COUNT(*) FILTER (WHERE u.stripe_subscription_id IS NOT NULL AND u.plan = 'professional') AS paid
        FROM users u WHERE u.created_at > NOW() - INTERVAL '30 days'`),
    ]);
    res.json({
      totalUsers:     Number(users.rows[0].total),
      newUsers7d:     Number(recent.rows[0].week),
      newUsers30d:    Number(recent.rows[0].month),
      activeTrials:   Number(trials.rows[0].total),
      plans:          plans.rows.map(r => ({ plan: r.plan, count: Number(r.count) })),
      signupsDaily:   daily.rows.map(r => ({ day: r.day, count: Number(r.count) })),
      totalApiKeys:   Number(keys.rows[0].total),
      totalMessages:  Number(messages.rows[0].total),
      unreadMessages: Number(unread.rows[0].total),
      signRequests:   signReqs.rows.map(r => ({ status: r.status, count: Number(r.count) })),
      distributions:  { total: Number(dists.rows[0].total), sent: Number(dists.rows[0].sent) },
      funnel30d:      Object.fromEntries(Object.entries(funnel.rows[0]).map(([k, v]) => [k, Number(v)])),
    });
  } catch (err) {
    console.error('admin/stats error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// GET /api/admin/users?page=1&limit=50&q=search&plan=free
router.get('/users', async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(200, parseInt(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  const q = String(req.query.q || '').trim().slice(0, 200);
  const plan = PLANS.includes(req.query.plan) ? req.query.plan : null;
  const where = [];
  const params = [];
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(LOWER(email) LIKE $${params.length} OR LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) LIKE $${params.length})`);
  }
  if (plan) { params.push(plan); where.push(`plan = $${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  try {
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT id, firebase_uid, email, first_name, last_name, plan, subscription_status,
                trial_active, trial_start, current_period_end, is_admin, stripe_customer_id, created_at
         FROM users ${clause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*) AS total FROM users ${clause}`, params),
    ]);
    const fb = await firebaseByUid(rows.rows.map(r => r.firebase_uid));
    const users = rows.rows.map(r => {
      const { firebase_uid, stripe_customer_id, ...rest } = r;
      return { ...rest, has_stripe: !!stripe_customer_id, developer: isDeveloper(r.email), owner: isOwner(r.email), firebase: fb.get(firebase_uid) || null };
    });
    res.json({ users, total: Number(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('admin/users error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// POST /api/admin/users/set-password  { email, password }
// Sets a user's Firebase login password directly (e.g. store reviewer accounts).
router.post('/users/set-password', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8–128 characters.' });
  try {
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(user.uid, { password });
    await admin.auth().revokeRefreshTokens(user.uid);
    await audit(req, 'set-password', user.email);
    res.json({ ok: true, email: user.email });
  } catch (err) {
    if (err?.code === 'auth/user-not-found') return res.status(404).json({ error: 'No login exists for that email.' });
    console.error('admin/set-password error:', err.message);
    res.status(500).json({ error: 'Could not set the password.' });
  }
});

// POST /api/admin/users/create  { email, password, firstName?, lastName?, plan? }
router.post('/users/create', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const firstName = String(req.body?.firstName || '').trim().slice(0, 100) || null;
  const lastName = String(req.body?.lastName || '').trim().slice(0, 100) || null;
  const plan = PLANS.includes(req.body?.plan) ? req.body.plan : 'free';
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8–128 characters.' });
  try {
    const record = await admin.auth().createUser({
      email, password, emailVerified: true,
      displayName: [firstName, lastName].filter(Boolean).join(' ') || undefined,
    });
    await pool.query(
      `INSERT INTO users (firebase_uid, email, first_name, last_name, plan, subscription_status, trial_active)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE)
       ON CONFLICT (email) DO UPDATE SET firebase_uid = EXCLUDED.firebase_uid, plan = EXCLUDED.plan, updated_at = NOW()`,
      [record.uid, email, firstName, lastName, plan, plan === 'inactive' ? 'inactive' : 'active']
    );
    await audit(req, 'create-user', email, `plan=${plan}`);
    res.json({ ok: true, email });
  } catch (err) {
    if (err?.code === 'auth/email-already-exists') return res.status(409).json({ error: 'A login already exists for that email.' });
    console.error('admin/create-user error:', err.message);
    res.status(500).json({ error: 'Could not create the user.' });
  }
});

// GET /api/admin/users/:id
router.get('/users/:id', async (req, res) => {
  const id = userId(req, res); if (!id) return;
  try {
    const user = await loadUser(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const [record, counts, keys, docs] = await Promise.all([
      firebaseRecordFor(user),
      pool.query(`SELECT
          (SELECT COUNT(*) FROM api_keys WHERE user_id = $1) AS api_keys,
          (SELECT COUNT(*) FROM signature_requests WHERE owner_user_id = $1) AS sign_requests,
          (SELECT COUNT(*) FROM distribution_batches WHERE owner_user_id = $1) AS distributions,
          (SELECT COUNT(*) FROM saved_contacts WHERE user_id = $1) AS saved_contacts`, [id]),
      pool.query('SELECT id, label, key_prefix, created_at, last_used_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC', [id]),
      pool.query('SELECT id, title, status, created_at FROM signature_requests WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 10', [id]),
    ]);
    const { firebase_uid, ...rest } = user;
    res.json({
      user: { ...rest, developer: isDeveloper(user.email), owner: isOwner(user.email) },
      firebase: firebaseSummary(record),
      counts: Object.fromEntries(Object.entries(counts.rows[0]).map(([k, v]) => [k, Number(v)])),
      apiKeys: keys.rows,
      recentSignRequests: docs.rows,
    });
  } catch (err) {
    console.error('admin/user detail error:', err.message);
    res.status(500).json({ error: 'Could not load that user.' });
  }
});

// POST /api/admin/users/:id/plan  { plan, status? }
router.post('/users/:id/plan', async (req, res) => {
  const id = userId(req, res); if (!id) return;
  const plan = req.body?.plan;
  if (!PLANS.includes(plan)) return res.status(400).json({ error: `Plan must be one of: ${PLANS.join(', ')}.` });
  const status = STATUSES.includes(req.body?.status)
    ? req.body.status
    : (plan === 'inactive' ? 'inactive' : plan === 'trial' ? 'trialing' : 'active');
  try {
    const { rows } = await pool.query(
      `UPDATE users SET plan = $1, subscription_status = $2,
              trial_active = ($1 = 'trial'),
              trial_start = CASE WHEN $1 = 'trial' THEN COALESCE(trial_start, NOW()) ELSE trial_start END,
              updated_at = NOW()
       WHERE id = $3 RETURNING email`,
      [plan, status, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    await audit(req, 'change-plan', rows[0].email, `plan=${plan} status=${status}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('admin/plan error:', err.message);
    res.status(500).json({ error: 'Could not change the plan.' });
  }
});

// POST /api/admin/users/:id/name  { firstName, lastName }
router.post('/users/:id/name', async (req, res) => {
  const id = userId(req, res); if (!id) return;
  const firstName = String(req.body?.firstName || '').trim().slice(0, 100) || null;
  const lastName = String(req.body?.lastName || '').trim().slice(0, 100) || null;
  try {
    const { rows } = await pool.query(
      'UPDATE users SET first_name = $1, last_name = $2, updated_at = NOW() WHERE id = $3 RETURNING email',
      [firstName, lastName, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    await audit(req, 'change-name', rows[0].email, [firstName, lastName].filter(Boolean).join(' '));
    res.json({ ok: true });
  } catch (err) {
    console.error('admin/name error:', err.message);
    res.status(500).json({ error: 'Could not change the name.' });
  }
});

// POST /api/admin/users/:id/disable  { disabled: true|false }
router.post('/users/:id/disable', async (req, res) => {
  const id = userId(req, res); if (!id) return;
  const disabled = req.body?.disabled === true;
  try {
    const user = await loadUser(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (isOwner(user.email)) return res.status(400).json({ error: 'The owner account cannot be disabled.' });
    const record = await firebaseRecordFor(user);
    if (!record) return res.status(404).json({ error: 'No login exists for that user.' });
    await admin.auth().updateUser(record.uid, { disabled });
    if (disabled) await admin.auth().revokeRefreshTokens(record.uid);
    await audit(req, disabled ? 'disable-login' : 'enable-login', user.email);
    res.json({ ok: true, disabled });
  } catch (err) {
    console.error('admin/disable error:', err.message);
    res.status(500).json({ error: 'Could not update the login.' });
  }
});

// POST /api/admin/users/:id/revoke-sessions
router.post('/users/:id/revoke-sessions', async (req, res) => {
  const id = userId(req, res); if (!id) return;
  try {
    const user = await loadUser(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const record = await firebaseRecordFor(user);
    if (!record) return res.status(404).json({ error: 'No login exists for that user.' });
    await admin.auth().revokeRefreshTokens(record.uid);
    await audit(req, 'revoke-sessions', user.email);
    res.json({ ok: true });
  } catch (err) {
    console.error('admin/revoke error:', err.message);
    res.status(500).json({ error: 'Could not sign that user out.' });
  }
});

// POST /api/admin/users/:id/verify-email
router.post('/users/:id/verify-email', async (req, res) => {
  const id = userId(req, res); if (!id) return;
  try {
    const user = await loadUser(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const record = await firebaseRecordFor(user);
    if (!record) return res.status(404).json({ error: 'No login exists for that user.' });
    await admin.auth().updateUser(record.uid, { emailVerified: true });
    await audit(req, 'verify-email', user.email);
    res.json({ ok: true });
  } catch (err) {
    console.error('admin/verify error:', err.message);
    res.status(500).json({ error: 'Could not verify the email.' });
  }
});

// POST /api/admin/users/:id/reset-link  -> { link }
router.post('/users/:id/reset-link', async (req, res) => {
  const id = userId(req, res); if (!id) return;
  try {
    const user = await loadUser(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const link = await admin.auth().generatePasswordResetLink(user.email, { url: 'https://www.nyxprism.com/login.html' });
    await audit(req, 'reset-link', user.email);
    res.json({ ok: true, link });
  } catch (err) {
    if (err?.code === 'auth/user-not-found' || err?.code === 'auth/email-not-found') {
      return res.status(404).json({ error: 'No login exists for that user.' });
    }
    console.error('admin/reset-link error:', err.message);
    res.status(500).json({ error: 'Could not create a reset link.' });
  }
});

// POST /api/admin/users/:id/admin  { isAdmin }  (owner only)
router.post('/users/:id/admin', requireOwner, async (req, res) => {
  const id = userId(req, res); if (!id) return;
  const isAdmin = req.body?.isAdmin === true;
  try {
    const { rows } = await pool.query(
      'UPDATE users SET is_admin = $1, updated_at = NOW() WHERE id = $2 RETURNING email', [isAdmin, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    await audit(req, isAdmin ? 'grant-admin' : 'revoke-admin', rows[0].email);
    res.json({ ok: true, isAdmin });
  } catch (err) {
    console.error('admin/admin-flag error:', err.message);
    res.status(500).json({ error: 'Could not change admin access.' });
  }
});

// DELETE /api/admin/users/:id  { confirmEmail }  (owner only)
router.delete('/users/:id', requireOwner, async (req, res) => {
  const id = userId(req, res); if (!id) return;
  try {
    const user = await loadUser(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (isOwner(user.email)) return res.status(400).json({ error: 'The owner account cannot be deleted.' });
    if (String(req.body?.confirmEmail || '').trim().toLowerCase() !== user.email.toLowerCase()) {
      return res.status(400).json({ error: "Type the user's email exactly to confirm." });
    }
    const record = await firebaseRecordFor(user);
    if (record) await admin.auth().deleteUser(record.uid);
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    await audit(req, 'delete-user', user.email);
    res.json({ ok: true });
  } catch (err) {
    console.error('admin/delete-user error:', err.message);
    res.status(500).json({ error: 'Could not delete the user.' });
  }
});

// GET /api/admin/messages?page=1&limit=20&unread=1
router.get('/messages', async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const clause = req.query.unread === '1' ? 'WHERE read = FALSE' : '';
  try {
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT id, first_name, last_name, email, subject, message, read, created_at
         FROM contact_messages ${clause} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query(`SELECT COUNT(*) AS total FROM contact_messages ${clause}`),
    ]);
    res.json({ messages: rows.rows, total: Number(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('admin/messages error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// POST /api/admin/messages/:id/read  { read }
router.post('/messages/:id/read', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid message id.' });
  try {
    await pool.query('UPDATE contact_messages SET read = $1 WHERE id = $2', [req.body?.read !== false, id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('admin/message read error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// DELETE /api/admin/messages/:id
router.delete('/messages/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid message id.' });
  try {
    const { rows } = await pool.query('DELETE FROM contact_messages WHERE id = $1 RETURNING email, subject', [id]);
    if (rows.length) await audit(req, 'delete-message', rows[0].email, rows[0].subject);
    res.json({ ok: true });
  } catch (err) {
    console.error('admin/message delete error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// GET /api/admin/api-keys
router.get('/api-keys', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT k.id, k.label, k.key_prefix, k.created_at, k.last_used_at, u.email
       FROM api_keys k JOIN users u ON u.id = k.user_id ORDER BY k.created_at DESC LIMIT 500`
    );
    res.json({ keys: rows });
  } catch (err) {
    console.error('admin/api-keys error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// DELETE /api/admin/api-keys/:id
router.delete('/api-keys/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid key id.' });
  try {
    const { rows } = await pool.query(
      'DELETE FROM api_keys k USING users u WHERE k.id = $1 AND u.id = k.user_id RETURNING k.key_prefix, u.email', [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Key not found.' });
    await audit(req, 'revoke-api-key', rows[0].email, rows[0].key_prefix);
    res.json({ ok: true });
  } catch (err) {
    console.error('admin/api-key delete error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// GET /api/admin/documents
router.get('/documents', async (_req, res) => {
  try {
    const [signRequests, distributions] = await Promise.all([
      pool.query(
        `SELECT r.id, r.title, r.document_name, r.document_size, r.status, r.created_at, r.sent_at, r.completed_at, r.expires_at,
                u.email AS owner, COUNT(sr.id) AS recipients, COUNT(sr.id) FILTER (WHERE sr.status = 'completed') AS signed
         FROM signature_requests r JOIN users u ON u.id = r.owner_user_id
         LEFT JOIN signature_recipients sr ON sr.request_id = r.id
         GROUP BY r.id, u.email ORDER BY r.created_at DESC LIMIT 200`
      ),
      pool.query(
        `SELECT b.id, b.title, b.document_name, b.document_size, b.status, b.created_at, b.sent_at, b.expires_at,
                u.email AS owner, COUNT(dr.id) AS recipients,
                COUNT(dr.id) FILTER (WHERE dr.opened_at IS NOT NULL) AS opened,
                COUNT(dr.id) FILTER (WHERE dr.failed_at IS NOT NULL) AS failed
         FROM distribution_batches b JOIN users u ON u.id = b.owner_user_id
         LEFT JOIN distribution_recipients dr ON dr.batch_id = b.id
         GROUP BY b.id, u.email ORDER BY b.created_at DESC LIMIT 200`
      ),
    ]);
    const numeric = ['recipients', 'signed', 'opened', 'failed'];
    const toNumbers = rows => rows.map(r => {
      const out = { ...r };
      numeric.forEach(k => { if (out[k] != null) out[k] = Number(out[k]); });
      return out;
    });
    res.json({ signRequests: toNumbers(signRequests.rows), distributions: toNumbers(distributions.rows) });
  } catch (err) {
    console.error('admin/documents error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// DELETE /api/admin/documents/:kind/:id  (kind = sign | dist; owner only)
router.delete('/documents/:kind/:id', requireOwner, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const table = req.params.kind === 'sign' ? 'signature_requests' : req.params.kind === 'dist' ? 'distribution_batches' : null;
  if (!table || !Number.isInteger(id)) return res.status(400).json({ error: 'Invalid document.' });
  try {
    const { rows } = await pool.query(`DELETE FROM ${table} WHERE id = $1 RETURNING title`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Document not found.' });
    await audit(req, `delete-${req.params.kind}-document`, `#${id}`, rows[0].title);
    res.json({ ok: true });
  } catch (err) {
    console.error('admin/document delete error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

// GET /api/admin/billing
router.get('/billing', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE stripe_subscription_id IS NOT NULL) AS subscribed,
            COUNT(*) FILTER (WHERE subscription_status = 'past_due') AS past_due,
            COUNT(*) FILTER (WHERE subscription_status = 'canceled') AS canceled
     FROM users`
  ).catch(() => ({ rows: [{}] }));
  const db = Object.fromEntries(Object.entries(rows[0] || {}).map(([k, v]) => [k, Number(v)]));
  if (!process.env.STRIPE_SECRET_KEY) return res.json({ configured: false, db });
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const subs = [];
    for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100, expand: ['data.customer'] })) {
      subs.push(sub);
      if (subs.length >= 500) break;
    }
    const key = process.env.STRIPE_SECRET_KEY;
    const keyMode = key.startsWith('sk_live_') || key.startsWith('rk_live_') ? 'live' : key.startsWith('sk_test_') || key.startsWith('rk_test_') ? 'test' : 'unknown';
    const account = await stripe.accounts.retrieve().then(a => ({
      id: a.id,
      name: a.settings?.dashboard?.display_name || a.business_profile?.name || null,
      email: a.email || null,
      country: a.country || null,
    })).catch(err => ({ error: err.message }));
    const checkPrice = async (label, id) => {
      if (!id) return { label, set: false };
      try {
        const p = await stripe.prices.retrieve(id, { expand: ['product'] });
        return { label, set: true, found: true, id, active: p.active, amountCents: p.unit_amount, currency: p.currency,
          interval: p.recurring?.interval || null, product: typeof p.product === 'object' ? p.product.name : p.product };
      } catch (err) {
        return { label, set: true, found: false, id, error: err.message };
      }
    };
    const prices = await Promise.all([
      checkPrice('Monthly', process.env.STRIPE_PRICE_ID_MONTHLY),
      checkPrice('Annual', process.env.STRIPE_PRICE_ID_ANNUAL),
    ]);
    const webhooks = await stripe.webhookEndpoints.list({ limit: 100 }).then(r => {
      const ours = r.data.filter(w => w.url.includes('/api/stripe/webhook'));
      return {
        secretSet: !!process.env.STRIPE_WEBHOOK_SECRET,
        endpoints: ours.map(w => ({ id: w.id, url: w.url, status: w.status, events: w.enabled_events })),
      };
    }).catch(err => ({ secretSet: !!process.env.STRIPE_WEBHOOK_SECRET, error: err.message }));

    let mrr = 0;
    for (const sub of subs.filter(s => ['active', 'past_due'].includes(s.status))) {
      for (const item of sub.items.data) {
        const amount = (item.price.unit_amount || 0) * (item.quantity || 1);
        const interval = item.price.recurring?.interval;
        const count = item.price.recurring?.interval_count || 1;
        const perMonth = { year: 1 / 12, month: 1, week: 52 / 12, day: 365 / 12 }[interval] ?? 1;
        mrr += amount * perMonth / count;
      }
    }
    res.json({
      configured: true,
      keyMode,
      account,
      prices,
      webhooks,
      livemode: keyMode === 'live' ? true : keyMode === 'test' ? false : (subs[0]?.livemode ?? null),
      currency: subs[0]?.currency || 'usd',
      mrrCents: Math.round(mrr),
      counts: subs.reduce((acc, s) => { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {}),
      subscriptions: subs.slice(0, 100).map(s => ({
        id: s.id,
        status: s.status,
        email: typeof s.customer === 'object' ? s.customer?.email : null,
        amountCents: s.items.data.reduce((t, i) => t + (i.price.unit_amount || 0) * (i.quantity || 1), 0),
        interval: s.items.data[0]?.price.recurring?.interval || null,
        currentPeriodEnd: (() => { const t = s.current_period_end ?? s.items.data[0]?.current_period_end; return t ? new Date(t * 1000).toISOString() : null; })(),
        cancelAtPeriodEnd: s.cancel_at_period_end,
        created: new Date(s.created * 1000).toISOString(),
      })),
      db,
    });
  } catch (err) {
    console.error('admin/billing error:', err.message);
    res.json({ configured: true, error: 'Could not reach Stripe: ' + err.message, db });
  }
});

// GET /api/admin/system
router.get('/system', async (_req, res) => {
  const started = Date.now();
  let database;
  try {
    await pool.query('SELECT 1');
    const latencyMs = Date.now() - started;
    const [size, tables] = await Promise.all([
      pool.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS size'),
      pool.query('SELECT relname AS table, n_live_tup AS rows FROM pg_stat_user_tables ORDER BY relname'),
    ]);
    database = { ok: true, latencyMs, size: size.rows[0].size, tables: tables.rows.map(t => ({ table: t.table, rows: Number(t.rows) })) };
  } catch (err) {
    database = { ok: false, error: err.message };
  }
  let firebase;
  try { await admin.auth().listUsers(1); firebase = { ok: true }; } catch (err) { firebase = { ok: false, error: err.message }; }
  const env = ['DATABASE_URL', 'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FRONTEND_URL',
    'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_ID_MONTHLY', 'STRIPE_PRICE_ID_ANNUAL',
    'BREVO_API_KEY', 'CONTACT_EMAIL', 'ANTHROPIC_API_KEY', 'DEVELOPER_EMAILS', 'AI_DAILY_LIMIT', 'SENTRY_DSN']
    .map(name => ({ name, set: !!process.env[name] }));
  res.json({
    database,
    firebase,
    env,
    runtime: {
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      environment: process.env.NODE_ENV || 'development',
      commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
  });
});

// GET /api/admin/audit?limit=100
router.get('/audit', async (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit) || 100);
  try {
    const { rows } = await pool.query(
      'SELECT id, actor, action, target, detail, created_at FROM admin_audit_log ORDER BY created_at DESC LIMIT $1', [limit]
    );
    res.json({ entries: rows });
  } catch (err) {
    console.error('admin/audit error:', err.message);
    res.status(500).json({ error: 'Database error.' });
  }
});

export default router;
