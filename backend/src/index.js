import 'dotenv/config';
import Sentry from './instrument.js';
import express from 'express';
import cors from 'cors';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import rateLimit from 'express-rate-limit';
import aiAssistRouter from './routes/ai-assist.js';
import aiDesktopRouter from './routes/ai-desktop.js';

import pool          from './db/index.js';
import { runLifecycleJobs } from './lifecycle.js';
import contactRouter  from './routes/contact.js';
import stripeRouter   from './routes/stripe.js';
import licenseRouter  from './routes/license.js';
import userRouter     from './routes/user.js';
import aiSplitRouter  from './routes/ai-split.js';
import apiKeysRouter  from './routes/api-keys.js';
import adminRouter    from './routes/admin.js';
import signRequestsRouter, { runSignatureReminders } from './routes/sign-requests.js';
import signTemplatesRouter from './routes/sign-templates.js';
import distributionsRouter from './routes/distributions.js';
import savedContactsRouter from './routes/saved-contacts.js';

const app  = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
// Railway terminates connections at one proxy hop; trust it so req.ip is the
// real client (rate limits and signature audit trails depend on this).
app.set('trust proxy', 1);
app.use((_req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  next();
});

// ── Stripe webhook must receive the RAW body — register BEFORE json() ───
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// ── CORS ─────────────────────────────────────────────────────────────────
// Always allow these regardless of env var:
const HARDCODED_ORIGINS = [
  'https://nyxprism.com',
  'https://www.nyxprism.com',
];

const allowedOrigins = [
  ...HARDCODED_ORIGINS,
  process.env.FRONTEND_URL,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (e.g. curl, Postman, CLI)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    // Allow only controlled NyxPrism subdomains. Preview deployments must be explicitly configured.
    if (/^https:\/\/([a-z0-9-]+\.)*nyxprism\.com$/.test(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '12mb' }));

// ── Rate limiting ─────────────────────────────────────────────────────────
// General API — 300 requests per 15 minutes per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

// AI split — expensive Claude calls; 20 per hour per IP
const aiSplitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI rate limit exceeded. Try again in an hour.' },
});

// Desktop AI — bulk jobs make one small request per document; 120 per hour per IP
const desktopAiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI rate limit exceeded. Try again in an hour.' },
});

// API key creation — 10 per hour per IP
const keyCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many API key creation requests. Try again later.' },
});

const publicDocumentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many document-link requests. Try again later.' },
});

app.use('/api', generalLimiter);
app.use('/api/sign-requests/public', publicDocumentLimiter);
app.use('/api/distributions/public', publicDocumentLimiter);

// ── Health check ─────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'nyxprism-api', database: 'available' });
  } catch {
    res.status(503).json({ ok: false, service: 'nyxprism-api', database: 'unavailable' });
  }
});

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/api/contact',   contactRouter);
app.use('/api/stripe',    stripeRouter);
app.use('/api/license',   licenseRouter);
app.use('/api/user',      userRouter);
app.use('/api/ai-split',  aiSplitLimiter, aiSplitRouter);
app.use('/api/ai-assist', aiSplitLimiter, aiAssistRouter);
app.use('/api/ai/desktop', desktopAiLimiter, aiDesktopRouter);
app.post('/api/keys',     keyCreateLimiter);
app.use('/api/keys',      apiKeysRouter);
app.use('/api/sign-requests', signRequestsRouter);
app.use('/api/sign-templates', signTemplatesRouter);
app.use('/api/distributions', distributionsRouter);
app.use('/api/saved-contacts', savedContactsRouter);
app.use('/api/admin',     adminRouter);

// Report unhandled route errors to Sentry (no-op when SENTRY_DSN is unset).
Sentry.setupExpressErrorHandler(app);

// ── 404 catch-all ────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

// ── Startup ───────────────────────────────────────────────────────────────
async function start() {
  const required = ['DATABASE_URL', 'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FRONTEND_URL'];
  const missing = required.filter(name => !process.env[name]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);

  // Apply schema (idempotent — uses IF NOT EXISTS)
  const __dir   = dirname(fileURLToPath(import.meta.url));
  const schema  = await readFile(join(__dir, 'db/schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('✓ Database schema applied.');

  const purgeExpiredDocuments = async () => {
    await pool.query("DELETE FROM signature_requests WHERE expires_at < NOW() - INTERVAL '30 days'");
    await pool.query("DELETE FROM distribution_batches WHERE expires_at < NOW() - INTERVAL '30 days'");
  };
  await purgeExpiredDocuments();
  const cleanupTimer = setInterval(() => purgeExpiredDocuments().catch(error => console.error('Retention cleanup error:', error.message)), 6 * 60 * 60 * 1000);
  cleanupTimer.unref();

  // Trial reminder emails (each is sent once per user, so repeated runs are safe).
  const lifecycle = () => runLifecycleJobs().catch(error => console.error('Lifecycle email job error:', error.message));
  setTimeout(lifecycle, 60 * 1000).unref();
  setInterval(lifecycle, 6 * 60 * 60 * 1000).unref();

  // Signature reminders to whoever's turn it is (every 3 days, at most 3 times).
  const reminders = () => runSignatureReminders().catch(error => console.error('Signature reminder job error:', error.message));
  setTimeout(reminders, 2 * 60 * 1000).unref();
  setInterval(reminders, 6 * 60 * 60 * 1000).unref();

  app.listen(PORT, () => console.log(`✓ NyxPrism API listening on port ${PORT}`));
}

start().catch(error => {
  console.error('✗ NyxPrism API failed to start:', error.message);
  process.exit(1);
});
