import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { developerEntitlements, hasProfessionalAccess } from '../src/access.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readRepo = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('owner account always receives Professional access', () => {
  assert.deepEqual(developerEntitlements('cmc@conniemichelleconsulting.com'), {
    plan: 'professional',
    subscription_status: 'active',
    trial_active: false,
    trial_start: null,
    current_period_end: null,
  });
});

test('store certification reviewer account receives Professional access', () => {
  assert.equal(developerEntitlements('msstore-review@nyxprism.com')?.plan, 'professional');
  assert.equal(developerEntitlements('MSStore-Review@nyxprism.com')?.plan, 'professional');
});

test('free accounts never receive Professional access, even with an active status', () => {
  const day = 24 * 60 * 60 * 1000;
  const acct = (plan, status, extra = {}) => ({ email: 'user@example.com', plan, subscription_status: status, ...extra });
  assert.equal(hasProfessionalAccess(acct('free', 'active')), false);
  assert.equal(hasProfessionalAccess(acct('inactive', 'canceled')), false);
  assert.equal(hasProfessionalAccess(acct('professional', 'active')), true);
  assert.equal(hasProfessionalAccess(acct('professional', 'past_due')), true);
  assert.equal(hasProfessionalAccess(acct('professional', 'canceled')), false);
  assert.equal(hasProfessionalAccess(acct('trial', 'trialing', { trial_start: new Date(Date.now() - 3 * day) })), true);
  assert.equal(hasProfessionalAccess(acct('trial', 'trialing', { trial_start: new Date(Date.now() - 15 * day) })), false);
  assert.equal(hasProfessionalAccess(acct('free', 'active', { email: 'cmc@conniemichelleconsulting.com' })), true);
  assert.equal(hasProfessionalAccess(null), false);
});

test('canceled subscriptions fall back to Free and webhooks re-read Stripe state', async () => {
  const stripe = await read('src/routes/stripe.js');
  assert.match(stripe, /subscriptions\.retrieve/);
  assert.match(stripe, /paid \? 'professional' : 'free'/);
  assert.doesNotMatch(stripe, /plan\s*=\s*'inactive'/);
  assert.match(stripe, /item\?\.current_period_end/);
});

test('paid operations enforce active plans on the server', async () => {
  for (const path of [
    'src/routes/ai-assist.js',
    'src/routes/ai-split.js',
    'src/routes/sign-requests.js',
    'src/routes/distributions.js',
    'src/routes/api-keys.js',
  ]) {
    const source = await read(path);
    assert.match(source, /requireActivePlan/);
  }
});

test('signature completion is consented, locked, and state checked', async () => {
  const source = await read('src/routes/sign-requests.js');
  assert.match(source, /consent !== true/);
  assert.match(source, /FOR UPDATE OF sr, r/);
  assert.match(source, /recipient_status !== 'pending'/);
  assert.match(source, /completion_hash/);
});

test('draft and revoked public workflows are inaccessible', async () => {
  const signatures = await read('src/routes/sign-requests.js');
  const distributions = await read('src/routes/distributions.js');
  assert.match(signatures, /request_status === 'draft'/);
  assert.match(distributions, /batch_status === 'draft'/);
  assert.match(distributions, /batch_status === 'revoked'/);
});

test('sensitive public responses opt out of caching', async () => {
  const signatures = await read('src/routes/sign-requests.js');
  const distributions = await read('src/routes/distributions.js');
  assert.match(signatures, /Cache-Control', 'no-store, max-age=0/);
  assert.match(distributions, /Cache-Control', 'no-store, max-age=0/);
});

test('backend disables framework disclosure and sets security headers', async () => {
  const source = await read('src/index.js');
  assert.match(source, /app\.disable\('x-powered-by'\)/);
  assert.match(source, /X-Content-Type-Options/);
  assert.match(source, /X-Frame-Options/);
  assert.match(source, /Referrer-Policy/);
});

test('public signer renders server fields without innerHTML interpolation', async () => {
  const source = await readRepo('docs/sign-request.html');
  // Server-provided names, labels and titles are only ever set as text.
  assert.doesNotMatch(source, /innerHTML/);
  assert.match(source, /consent: ?true/);
});

test('dashboard panel event uses the listener contract', async () => {
  const source = await readRepo('docs/dashboard.html');
  assert.match(source, /detail:\{panel:name\}/);
});

test('privacy policy discloses cloud document storage', async () => {
  const source = await readRepo('docs/privacy.html');
  assert.match(source, /Signature and distribution documents are stored in our database/);
  assert.doesNotMatch(source, /document contents are never seen by us/i);
});

test('Python project metadata declares dependencies outside project URLs', async () => {
  const source = await readRepo('pyproject.toml');
  assert.match(source, /\n\[project\.urls\]/);
  assert.match(source, /\ndependencies = \[/);
  assert.doesNotMatch(source, /\[project\.urls\][\s\S]*\ndependencies = \[/);
});

test('account lookup reconciles verified email and Firebase UID', async () => {
  const source = await read('src/routes/user.js');
  assert.match(source, /firebase_uid = \$1 OR LOWER\(email\) = LOWER\(\$2\)/);
  assert.match(source, /UPDATE users SET firebase_uid = \$1/);
});

test('dashboard never exposes an unavailable subscription plan', async () => {
  const source = await readRepo('docs/dashboard.html');
  assert.doesNotMatch(source, /plan='unavailable'/);
  assert.match(source, /plan='account'/);
  assert.match(source, /ownerAccount.*cmc@conniemichelleconsulting\.com/);
});

test('installed PWA registers and routes PDF files into the editor', async () => {
  const manifest = JSON.parse(await readRepo('docs/manifest.json'));
  const handler = manifest.file_handlers?.[0];
  assert.deepEqual(handler?.accept?.['application/pdf'], ['.pdf']);
  const dashboard = await readRepo('docs/dashboard.html');
  assert.match(dashboard, /launchQueue\.setConsumer/);
  assert.match(dashboard, /window\.__nyxOpenPdf/);
  assert.match(dashboard, /switchPanel\('editpdf'\)/);
});

test('landing and dashboard wallpapers use faceted glass geometry', async () => {
  for (const path of ['docs/index.html', 'docs/dashboard.html']) {
    const source = await readRepo(path);
    assert.match(source, /function transformPoint/);
    assert.match(source, /function polygonPath/);
    assert.match(source, /back\[side\].*front\[side\]/s);
  }
});

test('dynamic recipient rows use fixed accessible remove controls', async () => {
  const dashboard = await readRepo('docs/dashboard.html');
  assert.match(dashboard, /\.recipient-remove\{width:36px;height:36px;min-width:36px/);
  assert.match(dashboard, /sigreq-recipient recipient-row signature-recipient/);
  assert.match(dashboard, /recipient-row distribution-recipient/);
  assert.doesNotMatch(dashboard, /className='sigreq-recipient';row\.style\.cssText/);
});

test('saved people are user-scoped and automatically updated by document workflows', async () => {
  const schema = await read('src/db/schema.sql');
  const contacts = await read('src/routes/saved-contacts.js');
  const signatures = await read('src/routes/sign-requests.js');
  const distributions = await read('src/routes/distributions.js');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS saved_contacts/);
  assert.match(schema, /UNIQUE \(user_id, email\)/);
  assert.match(contacts, /WHERE user_id = \$1/);
  assert.match(signatures, /INSERT INTO saved_contacts/);
  assert.match(distributions, /INSERT INTO saved_contacts/);
  const dashboard = await readRepo('docs/dashboard.html');
  assert.match(dashboard, /api\/saved-contacts/);
  assert.match(dashboard, /id="sigreq-saved-person"/);
  assert.match(dashboard, /id="dist-saved-person"/);
});

test('account settings support name, password, email, and appearance changes', async () => {
  const dashboard = await readRepo('docs/dashboard.html');
  assert.match(dashboard, /id="acc-save-name"/);
  assert.match(dashboard, /id="acc-change-password"/);
  assert.match(dashboard, /id="acc-change-email"/);
  assert.match(dashboard, /reauthenticateWithCredential/);
  assert.match(dashboard, /verifyBeforeUpdateEmail/);
  assert.match(dashboard, /acc-theme-choices/);
  assert.match(dashboard, /acc-wallpaper-choices/);
  assert.match(dashboard, /acc-accent-choices/);
  const userRoutes = await read('src/routes/user.js');
  assert.match(userRoutes, /router\.post\('\/profile', requireAuth/);
  assert.match(userRoutes, /UPDATE users SET email = \$1/);
});
test('senders must verify their email before sending documents to other people', async () => {
  for (const path of ['src/routes/sign-requests.js', 'src/routes/distributions.js']) {
    const source = await read(path);
    assert.match(source, /router\.post\('\/', requireAuth, requireVerifiedEmail/);
    assert.match(source, /router\.post\('\/:id\/send', requireAuth, requireVerifiedEmail/);
  }
  const auth = await read('src/middleware/auth.js');
  assert.match(auth, /email_verified/);
});

test('desktop licence check uses the Professional access rule', async () => {
  const license = await read('src/routes/license.js');
  assert.match(license, /hasProfessionalAccess\(/);
  assert.doesNotMatch(license, /plan = 'inactive'/);
});

test('backend trusts exactly one proxy hop so rate limits and audit IPs are per client', async () => {
  assert.match(await read('src/index.js'), /app\.set\('trust proxy', 1\)/);
});

test('admin portal has no shared-secret login', async () => {
  const adminRoutes = await read('src/routes/admin.js');
  assert.doesNotMatch(adminRoutes, /ADMIN_SECRET|x-admin-secret/i);
  assert.doesNotMatch(await readRepo('docs/admin.html'), /admin secret/i);
});

test('AI routes use the shared helper with a per-user daily quota', async () => {
  for (const path of ['src/routes/ai-assist.js', 'src/routes/ai-split.js']) {
    const source = await read(path);
    assert.match(source, /aiDailyQuota/);
    assert.match(source, /askClaude\(/);
    assert.doesNotMatch(source, /content\[0\]/);
  }
});

test('completed signature PDFs carry a certificate and notify the sender', async () => {
  const source = await read('src/routes/sign-requests.js');
  assert.match(source, /Certificate of Completion/);
  assert.match(source, /notifyCompleted\(/);
  assert.match(source, /notifyDeclined\(/);
  assert.match(source, /router\.get\('\/public\/:token\/final-pdf'/);
});

test('signature requests are prepared in a four-step flow with validation', async () => {
  const dashboard = await readRepo('docs/dashboard.html');
  assert.match(dashboard, /function createWizard\(/);
  for (const step of ['Document', 'Signers', 'Place fields', 'Review &amp; send']) assert.ok(dashboard.includes(step), step);
  assert.match(dashboard, /still need.*at least one field/);
});

test('signers can draw or type signatures and download the completed copy', async () => {
  const signer = await readRepo('docs/sign-request.html');
  assert.match(signer, /id="sig-pad"/);
  assert.match(signer, /data-mode="type"/);
  assert.match(signer, /\/final-pdf/);
  assert.doesNotMatch(signer, /\bprompt\(|\bconfirm\(/);
});

test('desktop AI endpoint is Professional-only, quota-limited and size-capped', async () => {
  const source = await read('src/routes/ai-desktop.js');
  assert.match(source, /requireAuth, requireActivePlan, aiDailyQuota/);
  assert.match(source, /MAX_INPUT_CHARS/);
  assert.match(source, /MAX_OUTPUT_TOKENS/);
  assert.match(await read('src/index.js'), /app\.use\('\/api\/ai\/desktop', desktopAiLimiter/);
});
