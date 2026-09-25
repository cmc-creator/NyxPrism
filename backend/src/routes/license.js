import express from 'express';
import pool from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { developerEntitlements } from '../access.js';
import { activeTeamFor, hasAccess } from '../teams.js';

const router = express.Router();

// ── GET /api/license/verify ──────────────────────────────────────────────
// Called by the NyxPrism CLI to check whether the authenticated user has
// an active subscription or a valid trial.
router.get('/verify', requireAuth, async (req, res) => {
  const { uid } = req.user;
  const developer = developerEntitlements(req.user.email);

  if (developer) {
    return res.json({ valid: true, ...developer, reason: null });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, plan, subscription_status, trial_active, trial_start, current_period_end
       FROM users WHERE firebase_uid = $1`,
      [uid],
    );

    if (!rows.length) {
      return res.status(404).json({ valid: false, reason: 'User not found. Please log in at nyxprism.com.' });
    }

    const user = rows[0];
    // Free accounts have status "active" too, so the plan decides access.
    const valid = await hasAccess(user, req.user.email);
    const trialOver = user.plan === 'trial' && !valid;

    res.json({
      valid,
      plan:      valid && user.plan !== 'professional' && user.plan !== 'trial' ? 'professional' : user.plan,
      team:      (await activeTeamFor(user.id))?.name || null,
      status:    user.subscription_status,
      periodEnd: user.current_period_end ?? null,
      reason:    valid ? null
        : trialOver ? 'Your 14-day trial has ended. Subscribe at nyxprism.com to continue using Professional features.'
        : 'Professional features need an active subscription. Visit nyxprism.com to subscribe.',
    });
  } catch (err) {
    console.error('License verify error:', err);
    res.status(500).json({ valid: false, reason: 'Internal server error.' });
  }
});

export default router;
