import express from 'express';
import pool from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

const TRIAL_DAYS = 14;

// ── GET /api/license/verify ──────────────────────────────────────────────
// Called by the NyxPrism CLI to check whether the authenticated user has
// an active subscription or a valid trial.
router.get('/verify', requireAuth, async (req, res) => {
  const { uid } = req.user;

  try {
    const { rows } = await pool.query(
      `SELECT plan, subscription_status, trial_active, trial_start, current_period_end
       FROM users WHERE firebase_uid = $1`,
      [uid],
    );

    if (!rows.length) {
      return res.status(404).json({ valid: false, reason: 'User not found. Please log in at nyxprism.com.' });
    }

    const user = rows[0];
    const now  = new Date();

    // Expire stale trials
    if (user.trial_active && user.subscription_status === 'trialing') {
      const trialEnd = new Date(user.trial_start);
      trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);

      if (now > trialEnd) {
        await pool.query(
          `UPDATE users SET trial_active = false, subscription_status = 'trial_expired',
             plan = 'inactive', updated_at = NOW()
           WHERE firebase_uid = $1`,
          [uid],
        );
        return res.json({
          valid:  false,
          reason: 'Your 14-day trial has expired. Subscribe at nyxprism.com to continue.',
        });
      }
    }

    const valid = ['active', 'trialing'].includes(user.subscription_status);

    res.json({
      valid,
      plan:      user.plan,
      status:    user.subscription_status,
      periodEnd: user.current_period_end ?? null,
      reason:    valid ? null : 'No active subscription. Visit nyxprism.com to subscribe.',
    });
  } catch (err) {
    console.error('License verify error:', err);
    res.status(500).json({ valid: false, reason: 'Internal server error.' });
  }
});

export default router;
