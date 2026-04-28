import { Router } from 'express';
import { createHash, randomBytes } from 'crypto';
import pool from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const MAX_KEYS_PER_USER = 5;

// Helper: hash a key with SHA-256
function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

// GET /api/keys — list all keys for the authenticated user
router.get('/', requireAuth, async (req, res) => {
  try {
    const userRes = await pool.query(
      'SELECT id FROM users WHERE firebase_uid = $1',
      [req.user.uid]
    );
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found.' });
    const userId = userRes.rows[0].id;

    const result = await pool.query(
      'SELECT id, label, key_prefix, created_at, last_used_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    res.json({ keys: result.rows });
  } catch (err) {
    console.error('api-keys GET error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve API keys.' });
  }
});

// POST /api/keys — create a new key
router.post('/', requireAuth, async (req, res) => {
  const label = (req.body.label || 'My API Key').trim().slice(0, 60);

  try {
    const userRes = await pool.query(
      'SELECT id FROM users WHERE firebase_uid = $1',
      [req.user.uid]
    );
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found.' });
    const userId = userRes.rows[0].id;

    // Enforce per-user limit
    const countRes = await pool.query(
      'SELECT COUNT(*) FROM api_keys WHERE user_id = $1',
      [userId]
    );
    if (parseInt(countRes.rows[0].count, 10) >= MAX_KEYS_PER_USER) {
      return res.status(400).json({ error: `Maximum of ${MAX_KEYS_PER_USER} API keys allowed. Revoke an existing key first.` });
    }

    // Generate key: nyx_ + 32 hex chars = 36 chars total
    const rawKey = 'nyx_' + randomBytes(16).toString('hex');
    const prefix = rawKey.slice(0, 12); // "nyx_" + 8 chars shown in UI
    const hash   = hashKey(rawKey);

    await pool.query(
      'INSERT INTO api_keys (user_id, label, key_prefix, key_hash) VALUES ($1, $2, $3, $4)',
      [userId, label, prefix, hash]
    );

    // Return the full key ONCE — it is never stored in plaintext
    res.status(201).json({ key: rawKey, prefix, label });
  } catch (err) {
    console.error('api-keys POST error:', err.message);
    res.status(500).json({ error: 'Failed to create API key.' });
  }
});

// DELETE /api/keys/:id — revoke a key
router.delete('/:id', requireAuth, async (req, res) => {
  const keyId = parseInt(req.params.id, 10);
  if (!Number.isInteger(keyId) || keyId < 1) {
    return res.status(400).json({ error: 'Invalid key ID.' });
  }

  try {
    const userRes = await pool.query(
      'SELECT id FROM users WHERE firebase_uid = $1',
      [req.user.uid]
    );
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found.' });
    const userId = userRes.rows[0].id;

    const result = await pool.query(
      'DELETE FROM api_keys WHERE id = $1 AND user_id = $2',
      [keyId, userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Key not found or not owned by you.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('api-keys DELETE error:', err.message);
    res.status(500).json({ error: 'Failed to revoke API key.' });
  }
});

export default router;
