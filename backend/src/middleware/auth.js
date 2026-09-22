import admin from '../firebase.js';
import pool from '../db/index.js';
import { developerEntitlements } from '../access.js';

/**
 * Express middleware that verifies a Firebase ID token in the
 * Authorization: Bearer <token> header and sets req.user.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }
  try {
    const token   = header.slice(7);
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded; // { uid, email, ... }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

export async function requireActivePlan(req, res, next) {
  if (developerEntitlements(req.user?.email)) return next();

  try {
    const result = await pool.query(
      `SELECT plan, subscription_status, trial_start
       FROM users
       WHERE firebase_uid = $1
       LIMIT 1`,
      [req.user.uid],
    );
    if (!result.rows.length) {
      return res.status(403).json({ error: 'Create your NyxPrism account before using this feature.' });
    }

    const account = result.rows[0];
    const trialExpired = account.plan === 'trial' && account.trial_start &&
      Date.now() > new Date(account.trial_start).getTime() + 14 * 24 * 60 * 60 * 1000;
    const active = !trialExpired && ['active', 'trialing'].includes(account.subscription_status);

    if (!active) {
      return res.status(403).json({ error: 'An active trial or Professional subscription is required.' });
    }
    next();
  } catch (error) {
    console.error('Subscription authorization error:', error.message);
    res.status(500).json({ error: 'Unable to verify subscription access.' });
  }
}
