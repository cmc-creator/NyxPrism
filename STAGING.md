# Staging

A staging copy lets you try changes on test data before real customers see them.

- **Live:** `www.nyxprism.com` → production backend (Railway `production`), live Stripe.
- **Staging:** Vercel preview links (`*.vercel.app`) → staging backend (Railway `staging`), Stripe test mode.

`docs/config.js` picks the backend by site address, and preview sites show an orange **STAGING** label.

## One-time setup

1. **Railway → your project → Environments → New environment → "staging"**
   (duplicate `production` so the service and its settings are copied).
2. In **staging**, add a **new Postgres database** and point `DATABASE_URL` at it.
   Never share the production database.
3. In the staging service's **Variables**, change:
   - `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_MONTHLY`, `STRIPE_PRICE_ID_ANNUAL`, `STRIPE_WEBHOOK_SECRET` → your Stripe **sandbox / test mode** values
   - `ALLOW_PREVIEW_ORIGINS` → `true`
   - `NODE_ENV` → `staging` (Sentry then labels errors "staging")
   - Remove `BREVO_API_KEY` if you don't want staging to send real emails.
4. Under **Settings → Networking**, generate a public domain for the staging service
   (e.g. `nyxprism-staging.up.railway.app`).
5. Put that address in `docs/config.js` as `STAGING_API` and push.

Logins are shared with production (same Firebase project); all other data is separate.

## Everyday use

- Push to a branch (not `main`) → Vercel builds a preview link → it uses staging.
- When it looks right, merge to `main` → the live site and production backend update.
- The browser tests in `e2e/` run on every push (GitHub → Actions → CI).
