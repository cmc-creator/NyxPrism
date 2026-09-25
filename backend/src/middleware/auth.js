import admin from '../firebase.js';
import pool from '../db/index.js';
import { developerEntitlements, hasProfessionalAccess, isDeveloper } from '../access.js';
import { sendLifecycleEmail } from '../lifecycle.js';
import { hasAccess } from '../teams.js';

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
      `SELECT id, plan, subscription_status, trial_start
       FROM users
       WHERE firebase_uid = $1
       LIMIT 1`,
      [req.user.uid],
    );
    if (!result.rows.length) {
      return res.status(403).json({ error: 'Create your NyxPrism account before using this feature.' });
    }

    if (!(await hasAccess(result.rows[0], req.user.email))) {
      sendLifecycleEmail(result.rows[0].id, 'pro_nudge').catch(() => {});
      return res.status(403).json({ error: 'An active trial or Professional subscription is required.' });
    }
    next();
  } catch (error) {
    console.error('Subscription authorization error:', error.message);
    res.status(500).json({ error: 'Unable to verify subscription access.' });
  }
}

/**
 * Sending documents to other people shows the sender's email to recipients,
 * so the sender must have proven they own that address.
 */
export function requireVerifiedEmail(req, res, next) {
  if (req.user?.email_verified || isDeveloper(req.user?.email)) return next();
  res.status(403).json({ error: 'Verify your email address before sending documents to other people.', code: 'email_unverified' });
}
