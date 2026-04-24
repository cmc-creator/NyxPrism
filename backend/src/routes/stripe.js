import express from 'express';
import Stripe from 'stripe';
import pool from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICES = {
  monthly: process.env.STRIPE_PRICE_ID_MONTHLY,
  annual:  process.env.STRIPE_PRICE_ID_ANNUAL,
};

// ── POST /api/stripe/create-checkout ────────────────────────────────────
// Requires Firebase auth. Returns a Stripe Checkout URL.
router.post('/create-checkout', requireAuth, async (req, res) => {
  const { plan } = req.body ?? {};
  const priceId  = PRICES[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan. Use "monthly" or "annual".' });

  const { uid, email } = req.user;

  try {
    // Upsert user row and retrieve stripe_customer_id
    let { rows } = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE firebase_uid = $1',
      [uid],
    );
    let customerId = rows[0]?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { firebase_uid: uid },
      });
      customerId = customer.id;
      await pool.query(
        `INSERT INTO users (firebase_uid, email, stripe_customer_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (firebase_uid) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
        [uid, email, customerId],
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer:   customerId,
      mode:       'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/login.html?checkout=success`,
      cancel_url:  `${process.env.FRONTEND_URL}/login.html?checkout=cancel`,
      allow_promotion_codes: true,
      subscription_data: {
        trial_period_days: 14,
        metadata: { firebase_uid: uid },
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

// ── POST /api/stripe/webhook ─────────────────────────────────────────────
// Raw body required — registered in index.js BEFORE express.json()
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const firebaseUid = obj.metadata?.firebase_uid;
        if (!firebaseUid) break;

        const isActive = ['active', 'trialing'].includes(obj.status);

        await pool.query(
          `UPDATE users SET
             stripe_subscription_id = $1,
             stripe_price_id        = $2,
             subscription_status    = $3,
             trial_active           = $4,
             current_period_end     = to_timestamp($5),
             plan                   = $6,
             updated_at             = NOW()
           WHERE firebase_uid = $7`,
          [
            obj.id,
            obj.items.data[0]?.price.id ?? null,
            obj.status,
            obj.status === 'trialing',
            obj.current_period_end,
            isActive ? 'professional' : 'inactive',
            firebaseUid,
          ],
        );
        break;
      }

      case 'customer.subscription.deleted': {
        const firebaseUid = obj.metadata?.firebase_uid;
        if (!firebaseUid) break;

        await pool.query(
          `UPDATE users SET
             subscription_status = 'canceled',
             trial_active        = false,
             plan                = 'inactive',
             updated_at          = NOW()
           WHERE firebase_uid = $1`,
          [firebaseUid],
        );
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).send('Internal error processing webhook.');
  }

  res.json({ received: true });
});

export default router;
