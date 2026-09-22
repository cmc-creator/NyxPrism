import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import rateLimit from 'express-rate-limit';
import aiAssistRouter from './routes/ai-assist.js';

import pool          from './db/index.js';
import contactRouter  from './routes/contact.js';
import stripeRouter   from './routes/stripe.js';
import licenseRouter  from './routes/license.js';
import userRouter     from './routes/user.js';
import aiSplitRouter  from './routes/ai-split.js';
import apiKeysRouter  from './routes/api-keys.js';
import adminRouter    from './routes/admin.js';
import signRequestsRouter from './routes/sign-requests.js';
import distributionsRouter from './routes/distributions.js';

const app  = express();
const PORT = process.env.PORT || 3000;

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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Secret'],
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

// API key creation — 10 per hour per IP
const keyCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many API key creation requests. Try again later.' },
});

app.use('/api', generalLimiter);

// ── Health check ─────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, service: 'nyxprism-api' }));

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/api/contact',   contactRouter);
app.use('/api/stripe',    stripeRouter);
app.use('/api/license',   licenseRouter);
app.use('/api/user',      userRouter);
app.use('/api/ai-split',  aiSplitLimiter, aiSplitRouter);
app.use('/api/ai-assist', aiSplitLimiter, aiAssistRouter);
app.post('/api/keys',     keyCreateLimiter);
app.use('/api/keys',      apiKeysRouter);
app.use('/api/sign-requests', signRequestsRouter);
app.use('/api/distributions', distributionsRouter);
app.use('/api/admin',     adminRouter);

// ── 404 catch-all ────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

// ── Startup ───────────────────────────────────────────────────────────────
async function start() {
  // Bind the port first so Railway's healthcheck can hit /health immediately.
  await new Promise(resolve => app.listen(PORT, () => {
    console.log(`✓ NyxPrism API listening on port ${PORT}`);
    resolve();
  }));

  // Apply schema (idempotent — uses IF NOT EXISTS)
  try {
    const __dir   = dirname(fileURLToPath(import.meta.url));
    const schema  = await readFile(join(__dir, 'db/schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('✓ Database schema applied.');
  } catch (err) {
    console.error('✗ Schema migration error (server stays up):', err.message);
    // Do NOT exit — let the server keep running so /health stays reachable.
    // DB-dependent routes will fail gracefully; fix DATABASE_URL in env vars.
  }
}

start();
