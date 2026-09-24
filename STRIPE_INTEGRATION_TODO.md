# Stripe Integration — Remaining Setup

NyxPrism uses **Stripe-hosted Checkout** for the Professional subscription
($12/month or $99/year). The code is done; what's left is configuration in
Stripe and Railway.

## Values to Replace

No placeholder values remain in code. `mode`, `success_url`, `cancel_url` and
`line_items` already use real values:

**Files containing these values:**
- [backend/src/routes/stripe.js](backend/src/routes/stripe.js)

| Field | Current Value | Notes |
|-------|--------------|-------|
| mode | `subscription` | Correct for the recurring Professional plan. |
| success_url | `${FRONTEND_URL}/dashboard.html?checkout=success` | Dashboard shows a "Subscription activated" message. |
| cancel_url | `${FRONTEND_URL}/dashboard.html` | Returns to the dashboard. |
| line_items[].price | `STRIPE_PRICE_ID_MONTHLY` / `STRIPE_PRICE_ID_ANNUAL` (Railway variables) | Set these to your **live** price IDs (see Setup). |

## Configured Parameters

These parameters were configured in Checkout Studio and are set in the
Checkout Session call.

**Files containing these parameters:**
- [backend/src/routes/stripe.js](backend/src/routes/stripe.js)

| Parameter | Value |
|-----------|-------|
| ui_mode | `hosted` (installed `stripe` SDK is 16.x; use `hosted_page` after upgrading to ≥ 21.0.0) |
| billing_address_collection | `auto` |
| phone_number_collection | `{ enabled: true }` |
| automatic_tax | `{ enabled: false }` |
| allow_promotion_codes | `true` |
| payment_method_collection | `always` |
| submit_type | `auto` |
| saved_payment_method_options | `{ payment_method_save: 'enabled' }` |
| integration_identifier | `hosted_web_0001` |
| origin_context | `web` |

Kept on purpose (not part of Checkout Studio): `customer` and
`subscription_data.metadata.firebase_uid`. The webhook uses them to upgrade
the right NyxPrism account after payment.

If Stripe rejects one of the newer optional fields (`integration_identifier`,
`origin_context`, `submit_type`, `saved_payment_method_options`,
`phone_number_collection`) for this SDK's API version, the server drops only
that field, logs a warning, and retries, so checkout keeps working.

## Setup

Do these in the **live** Stripe account (top-left shows *NyxPrism /
NyxCollective LLC*), not the sandbox.

1. **Product and prices.** Product catalog → *NyxPrism Professional* with a
   $12.00 monthly and a $99.00 yearly recurring price. Copy both `price_…` IDs.
2. **Secret key.** Developers → API keys → Secret key (`sk_live_…`).
3. **Webhook.** Workbench → Webhooks → *Add destination*
   - Events: `customer.subscription.created`, `customer.subscription.updated`,
     `customer.subscription.deleted`
   - Type: Webhook endpoint
   - URL: `https://nyxprism-production.up.railway.app/api/stripe/webhook`
   - Copy the signing secret (`whsec_…`).
4. **Customer portal.** Settings → Billing → Customer portal → Activate; allow
   cancel and switching between monthly/yearly. (Powers *Manage Billing*.)
5. **Emails.** Settings → Billing → Subscriptions and emails → receipts,
   upcoming-renewal and failed-payment emails, and Smart Retries.
6. **Verify your account** in Stripe's Setup guide (business + bank details).
   Live payments are blocked until this is done.
7. **Railway** → *nyxprism-production* → Variables:

   | Variable | Value |
   |----------|-------|
   | `STRIPE_SECRET_KEY` | `sk_live_…` |
   | `STRIPE_PRICE_ID_MONTHLY` | live monthly `price_…` |
   | `STRIPE_PRICE_ID_ANNUAL` | live yearly `price_…` |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_…` from step 3 |

   No publishable key is needed: Checkout is hosted by Stripe and the browser
   only receives the session URL.
8. **Check.** nyxprism.com/admin → Billing → Refresh. The *Stripe connection*
   card should say **Live** with every line green.

## How it works

1. A signed-in user clicks **Upgrade** → the dashboard calls
   `POST /api/stripe/create-checkout` with `monthly` or `annual`.
2. The backend creates (or reuses) the Stripe customer, creates a Checkout
   Session, and returns its URL; the browser redirects to Stripe.
3. After payment Stripe sends `customer.subscription.*` webhooks to
   `/api/stripe/webhook`. The backend verifies the signature, re-reads the
   subscription from Stripe, and sets the user to **Professional**
   (`active`/`trialing`/`past_due`) or back to **Free** (canceled/lapsed).
4. **Manage Billing** opens the Stripe customer portal for cancel/plan changes.

## Testing

In the sandbox (with `sk_test_…` keys and sandbox price IDs/webhook):

| Card | Result |
|------|--------|
| `4242 4242 4242 4242` | Payment succeeds |
| `4000 0025 0000 3155` | Requires 3-D Secure authentication |
| `4000 0000 0000 9995` | Declined (insufficient funds) |

Use any future expiry date and any 3-digit CVC. Resend a webhook from
Workbench → Webhooks → your destination → an event → *Resend*.

## Next steps

- Upgrade the `stripe` package to ≥ 21 when convenient, then change
  `ui_mode` to `hosted_page`.
- Turn on `automatic_tax` once Stripe Tax is registered where you owe tax.
- Enterprise deals: bill with Stripe Invoicing (Invoices → Create invoice).

## Resources

- https://support.stripe.com
- https://docs.stripe.com/mcp
