import admin from '../firebase.js';

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
