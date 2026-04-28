import { createHash } from 'crypto';
import pool from '../db/index.js';

/**
 * Express middleware that authenticates requests using a NyxPrism API key.
 * Accepts: Authorization: Bearer nyx_<hex>
 * On success sets req.user = { userId, firebase_uid, email, plan } and
 * asynchronously updates last_used_at.
 */
export async function requireApiKey(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer nyx_')) {
    return res.status(401).json({ error: 'Missing or invalid API key. Use Authorization: Bearer nyx_...' });
  }

  const rawKey = header.slice(7); // strip "Bearer "
  const hash   = createHash('sha256').update(rawKey).digest('hex');

  try {
    const result = await pool.query(
      `SELECT ak.id AS key_id, u.id AS user_id, u.firebase_uid, u.email,
              u.plan, u.subscription_status, u.trial_active, u.trial_start, u.current_period_end
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.key_hash = $1`,
      [hash]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'Invalid API key.' });
    }

    const row = result.rows[0];

    // Check that the key owner has an active plan
    const trialExpired =
      row.plan === 'trial' &&
      row.trial_start &&
      Date.now() > new Date(row.trial_start).getTime() + 14 * 24 * 60 * 60 * 1000;

    if (row.plan === 'inactive' || trialExpired) {
      return res.status(403).json({ error: 'Your subscription is inactive. Please renew at https://nyxprism.com/dashboard.html' });
    }

    req.user = {
      uid:    row.firebase_uid,
      userId: row.user_id,
      email:  row.email,
      plan:   row.plan,
    };

    // Update last_used_at without blocking the request
    pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.key_id]).catch(() => {});

    next();
  } catch (err) {
    console.error('apiAuth error:', err.message);
    res.status(500).json({ error: 'Authentication error.' });
  }
}
