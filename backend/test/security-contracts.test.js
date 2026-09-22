import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { developerEntitlements } from '../src/access.js';

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
  assert.match(source, /row\.append\(strong,type,input\)/);
  assert.doesNotMatch(source, /row\.innerHTML='<strong>'\+label/);
  assert.match(source, /consent:true/);
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