import express from 'express';
import Stripe from 'stripe';
import pool from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured.');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

const PRICES = {
  monthly: process.env.STRIPE_PRICE_ID_MONTHLY,
  annual:  process.env.STRIPE_PRICE_ID_ANNUAL,
};

// Subscription states in which the customer keeps Professional access.
// past_due: Stripe is still retrying a failed renewal.
const PAID_STATUSES = ['active', 'trialing', 'past_due'];
const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

// Webhook events can arrive late or out of order, so always re-read the
// subscription from Stripe and store its current state rather than the
// (possibly stale) copy inside the event.
async function syncSubscription(stripe, eventSubscription) {
  let sub = eventSubscription;
  try {
    sub = await stripe.subscriptions.retrieve(eventSubscription.id);
  } catch (err) {
    if (err?.code !== 'resource_missing') throw err;
  }
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  const firebaseUid = sub.metadata?.firebase_uid || null;
  const item = sub.items?.data?.[0];
  // Newer Stripe API versions moved current_period_end onto subscription items.
  const periodEnd = sub.current_period_end ?? item?.current_period_end ?? null;
  const paid = PAID_STATUSES.includes(sub.status);

  await pool.query(
    `UPDATE users SET
       stripe_customer_id     = COALESCE(stripe_customer_id, $1),
       stripe_subscription_id = $2,
       stripe_price_id        = $3,
       subscription_status    = $4,
       trial_active           = $5,
       current_period_end     = to_timestamp($6),
       plan                   = $7,
       updated_at             = NOW()
     WHERE (firebase_uid = $8 OR stripe_customer_id = $1)
       AND (stripe_subscription_id IS NULL OR stripe_subscription_id = $2 OR $9)`,
    [
      customerId,
      sub.id,
      item?.price?.id ?? null,
      sub.status,
      sub.status === 'trialing',
      periodEnd,
      // A lapsed or canceled subscriber drops back to the Free plan, not a lockout.
      paid ? 'professional' : 'free',
      firebaseUid,
      paid,
    ],
  );
}

// ΓöÇΓöÇ POST /api/stripe/create-checkout ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Requires Firebase auth. Returns a Stripe Checkout URL.
router.post('/create-checkout', requireAuth, async (req, res) => {
  const { plan } = req.body ?? {};
  const priceId  = PRICES[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan. Use "monthly" or "annual".' });

  const { uid, email } = req.user;

  try {
    const stripe = getStripe();
    // Upsert user row and retrieve stripe_customer_id
    let { rows } = await pool.query(
      'SELECT stripe_customer_id, stripe_subscription_id, plan, subscription_status FROM users WHERE firebase_uid = $1',
      [uid],
    );
    // Free accounts are "active" too; only a live paid subscription blocks a new checkout.
    const current = rows[0];
    if (current?.stripe_subscription_id && current.plan === 'professional' && PAID_STATUSES.includes(current.subscription_status)) {
      return res.status(409).json({ error: 'This account already has an active subscription.' });
    }
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
      success_url: `${process.env.FRONTEND_URL}/dashboard.html?checkout=success`,
      cancel_url:  `${process.env.FRONTEND_URL}/dashboard.html`,
      allow_promotion_codes: true,
      subscription_data: { metadata: { firebase_uid: uid } },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

// ΓöÇΓöÇ POST /api/stripe/create-portal ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Creates a Stripe Customer Portal session so the user can manage billing.
router.post('/create-portal', requireAuth, async (req, res) => {
  const { uid, email } = req.user;
  try {
    const stripe = getStripe();
    let { rows } = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE firebase_uid = $1 OR email = $2 LIMIT 1',
      [uid, email],
    );
    let customerId = rows[0]?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email, metadata: { firebase_uid: uid } });
      customerId = customer.id;
      await pool.query(
        `INSERT INTO users (firebase_uid, email, stripe_customer_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (firebase_uid) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
        [uid, email, customerId],
      );
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.FRONTEND_URL}/dashboard.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({ error: 'Failed to open billing portal.' });
  }
});

// ΓöÇΓöÇ POST /api/stripe/webhook ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Raw body required ΓÇö registered in index.js BEFORE express.json()
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send('Webhook signature verification failed.');
  }

  try {
    if (SUBSCRIPTION_EVENTS.has(event.type)) {
      await syncSubscription(getStripe(), event.data.object);
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).send('Internal error processing webhook.');
  }

  res.json({ received: true });
});

export default router;
