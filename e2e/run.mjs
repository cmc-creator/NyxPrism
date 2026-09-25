// NyxPrism browser tests. Run: cd e2e && npm install && npm test
// Set CHROME_PATH to use an installed Chrome instead of Puppeteer's download.
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import express from 'express';
import { PDFDocument } from 'pdf-lib';
import { REPO, wait, startSite, launch, newPage, PRO_ME, makePdf, openPanel, dropFile, backendCopy } from './harness.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-e2e-'));
const PDF3 = await makePdf(path.join(tmp, 'three.pdf'), 3);
const PDF2 = await makePdf(path.join(tmp, 'two.pdf'), 2);
const site = await startSite(5701);
const SITE = 'http://localhost:5701';
const browser = await launch();
const results = [];

async function test(name, fn) {
  const started = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`✔ ${name} (${Date.now() - started} ms)`); }
  catch (err) { results.push({ name, ok: false }); console.log(`✖ ${name}\n  ${err.stack?.split('\n').slice(0, 3).join('\n  ')}`); }
}
const step = (page, root) => page.$eval(`${root} .wizard-pane.active`, e => e.dataset.step);
const error = (page, root) => page.$eval(`${root} .wizard-pane.active [data-error]`, e => (e.classList.contains('show') ? e.textContent : ''));
const next = async (page, root) => { await page.click(`${root} .wizard-pane.active [data-next]`); await wait(350); };

const baseApi = (extra = {}) => (method, p, body) => {
  if (extra[`${method} ${p}`]) return extra[`${method} ${p}`](body);
  if (p === '/api/user/me') return PRO_ME;
  if (p === '/api/saved-contacts') return { contacts: [] };
  if (p === '/api/sign-requests' && method === 'GET') return { requests: [] };
  if (p === '/api/sign-templates' && method === 'GET') return { templates: [] };
  if (p === '/api/distributions' && method === 'GET') return { batches: [] };
  return {};
};

await test('public tool pages render with structured data and no layout overflow', async () => {
  const page = await newPage(browser, null);
  for (const slug of ['tools', 'split-pdf', 'request-signatures']) {
    for (const width of [1280, 390]) {
      await page.setViewport({ width, height: 900 });
      await page.goto(`${SITE}/${slug}`, { waitUntil: 'domcontentloaded' });
      assert.ok((await page.title()).includes('NyxPrism'), `${slug} title`);
      const types = await page.$$eval('script[type="application/ld+json"]', s => s.map(x => JSON.parse(x.textContent)['@type']));
      assert.ok(types.length >= 1, `${slug} structured data`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${slug} overflows at ${width}px`);
    }
  }
  const cta = await page.$eval('a.btn.primary', a => a.getAttribute('href'));
  assert.match(cta, /login\.html\?next=signrequest#trial/);
  assert.deepEqual(page.errors, []);
});

await test('dashboard deep link opens the tool and single-step tools show progress', async () => {
  const page = await newPage(browser, baseApi());
  await page.goto(`${SITE}/dashboard.html#split`, { waitUntil: 'networkidle2' }); await wait(800);
  assert.equal(await page.$eval('.panel.active', e => e.id), 'panel-split');
  const strip = id => page.$eval(`#panel-${id} .tool-steps`, ol => [...ol.children].map(li => (li.classList.contains('done') ? 'D' : li.classList.contains('active') ? 'A' : '-')).join(''));
  assert.equal(await strip('split'), 'A--');
  await (await page.$('#split-file')).uploadFile(PDF3); await wait(1200);
  assert.equal(await strip('split'), 'DA-');
  await page.click('#split-run'); await wait(4000);
  assert.equal(await strip('split'), 'DDD');
  await openPanel(page, 'number');
  await dropFile(page, '#num-drop', PDF3, 'REPORT.PDF', '');
  await wait(400);
  assert.equal(await page.$eval('#num-file', i => i.files[0]?.name), 'REPORT.PDF', 'dropped file reaches the tool');
  assert.equal(await strip('number'), 'DA-');
  assert.deepEqual(page.errors, []);
});

await test('request signatures: four-step flow validates each step and sends', async () => {
  let posted = null;
  const page = await newPage(browser, baseApi({ 'POST /api/sign-requests': body => { posted = body; return [201, { request: { id: 1 }, signers: [] }]; } }));
  await page.goto(`${SITE}/dashboard.html#signrequest`, { waitUntil: 'networkidle2' }); await wait(800);
  const W = '#sigreq-wizard';
  await next(page, W); assert.match(await error(page, W), /Upload a PDF/);
  await (await page.$('#sigreq-file')).uploadFile(PDF2); await wait(1200);
  await next(page, W); assert.equal(await step(page, W), '2');
  await next(page, W); assert.match(await error(page, W), /at least one signer/);
  await page.type('#sigreq-recipients .sr-name', 'Ann'); await page.type('#sigreq-recipients .sr-email', 'ann@example.com');
  await page.click('#sigreq-add-recipient');
  const rows = await page.$$('#sigreq-recipients .sigreq-recipient');
  await (await rows[1].$('.sr-name')).type('Bob'); await (await rows[1].$('.sr-email')).type('bob@example.com');
  await next(page, W); assert.equal(await step(page, W), '3');
  await page.click('.sigreq-field-btn[data-field="signature"]');
  await next(page, W); assert.match(await error(page, W), /Bob still needs/);
  await page.click('.signer-chip:nth-child(2)'); await page.click('.sigreq-field-btn[data-field="date"]');
  await next(page, W); assert.equal(await step(page, W), '4');
  await page.click('#sigreq-send'); await wait(800);
  assert.equal(posted.sendNow, true);
  assert.deepEqual(posted.fields.map(f => f.assignedTo), ['ann@example.com', 'bob@example.com']);
  assert.equal(await page.$eval('#sigreq-done', e => getComputedStyle(e).display !== 'none'), true);
  assert.deepEqual(page.errors, []);
});

await test('request signatures: a saved person fills the empty row and can be given fields', async () => {
  const page = await newPage(browser, baseApi({ 'GET /api/saved-contacts': () => ({ contacts: [{ id: 1, name: 'Sam Saved', email: 'sam@example.com' }] }) }));
  await page.goto(`${SITE}/dashboard.html#signrequest`, { waitUntil: 'networkidle2' }); await wait(800);
  const W = '#sigreq-wizard';
  await (await page.$('#sigreq-file')).uploadFile(PDF2); await wait(1200);
  await next(page, W);
  await page.select('#sigreq-saved-person', '1'); await page.click('#sigreq-use-saved');
  assert.equal((await page.$$('#sigreq-recipients .sigreq-recipient')).length, 1);
  await page.click('#sigreq-add-recipient'); await page.click('#sigreq-add-recipient');
  const rows = await page.$$('#sigreq-recipients .sigreq-recipient');
  await (await rows[1].$('.sr-name')).type('Bob'); await (await rows[1].$('.sr-email')).type('Bob@Example.com');
  await next(page, W); assert.equal(await step(page, W), '3');
  assert.equal((await page.$$('#sigreq-recipients .sigreq-recipient')).length, 2);
  await page.click('.sigreq-field-btn[data-field="signature"]');
  await page.click('.signer-chip:nth-child(2)'); await page.click('.sigreq-field-btn[data-field="date"]');
  assert.equal(await page.$$eval('.sigreq-box', b => b.length), 2);
  await next(page, W); assert.equal(await step(page, W), '4');
  assert.deepEqual(page.errors, []);
});

await test('distribute: paste a list, dedupe, review and send', async () => {
  let posted = null;
  const page = await newPage(browser, baseApi({ 'POST /api/distributions': body => { posted = body; return [201, { batch: { id: 1 } }]; } }));
  await page.goto(`${SITE}/dashboard.html#distribution`, { waitUntil: 'networkidle2' }); await wait(800);
  const W = '#dist-wizard';
  await (await page.$('#dist-file')).uploadFile(PDF2); await wait(500);
  await next(page, W);
  await page.click('#dist-paste-open');
  await page.type('#dist-paste', 'Jane Smith, jane@example.com\nsam@example.com\nno email here\njane@example.com');
  await page.click('#dist-paste-add'); await wait(200);
  assert.match(await page.$eval('#dist-paste-note', e => e.textContent), /Added 2, skipped 2/);
  await next(page, W); assert.equal(await step(page, W), '3');
  await page.click('#dist-send'); await wait(800);
  assert.equal(posted.recipients.length, 2);
  assert.deepEqual(page.errors, []);
});

await test('teams: owner manages seats and invites; invite links are accepted', async () => {
  let invited = null, accepted = null;
  const team = { team: { id: 1, name: 'Acme Legal', seats: 3, used: 1 }, role: 'owner', owner: { email: 'tester@example.com', first_name: 'Tess' },
    members: [{ id: 5, email: 'amy@acme.com', role: 'member', status: 'active', first_name: 'Amy' }] };
  const page = await newPage(browser, baseApi({
    'GET /api/teams/mine': () => team,
    'POST /api/teams/invite': body => { invited = body; return [201, { ok: true }]; },
    'POST /api/teams/accept': body => { accepted = body; return { ok: true, team: 'Acme Legal' }; },
    'GET /api/user/brand': () => ({ name: '', logoUrl: null }),
  }));
  await page.goto(`${SITE}/dashboard.html?team_invite=${'a'.repeat(48)}#account`, { waitUntil: 'networkidle2' }); await wait(2000);
  assert.equal(accepted?.token, 'a'.repeat(48), 'invite link accepted');
  const body = await page.$eval('#team-body', e => e.innerText);
  assert.match(body, /Acme Legal/); assert.match(body, /1 of 3 seats used/); assert.match(body, /amy@acme\.com/);
  await page.type('#team-body input[type=email]', 'bo@acme.com');
  await page.click('#team-body .btn-primary'); await wait(500);
  assert.deepEqual(invited, { email: 'bo@acme.com', role: 'member' });
  assert.deepEqual(page.errors, []);
});

await test('owner portal: add a user with a plan and team, change plans inline', async () => {
  let created = null, planChange = null;
  const users = [{ id: 3, email: 'jo@example.com', first_name: 'Jo', plan: 'free', subscription_status: 'active', created_at: new Date().toISOString(), firebase: { lastSignInAt: null } },
    { id: 1, email: 'cmc@conniemichelleconsulting.com', plan: 'professional', subscription_status: 'active', owner: true, developer: true, created_at: new Date().toISOString(), firebase: {} }];
  const page = await newPage(browser, (method, p, body) => {
    if (p === '/api/admin/me') return { email: 'cmc@conniemichelleconsulting.com', owner: true, auth: 'owner' };
    if (p === '/api/admin/users' && method === 'GET') return { users, total: users.length };
    if (p === '/api/admin/teams') return { teams: [{ id: 9, name: 'Acme Legal', seats: 5, active: 1, invited: 0 }] };
    if (p === '/api/admin/users/create') { created = body; return { ok: true, email: body.email, team: 'Acme Legal' }; }
    if (p === '/api/admin/users/3/plan') { planChange = body; return { ok: true }; }
    if (p === '/api/admin/stats') return { totalUsers: 2, newUsers7d: 0, newUsers30d: 0, activeTrials: 0, plans: [], signupsDaily: [{ day: '2026-09-01', count: 0 }], totalApiKeys: 0, totalMessages: 0, unreadMessages: 0, signRequests: [], distributions: { total: 0, sent: 0 }, funnel30d: {} };
    return {};
  });
  await page.goto(`${SITE}/admin.html#users`, { waitUntil: 'networkidle2' }); await wait(1200);
  assert.equal(await page.$('[data-plan-for="1"]'), null, 'owner plan is fixed');
  await page.select('[data-plan-for="3"]', 'professional'); await wait(400);
  assert.deepEqual(planChange, { plan: 'professional' });
  await page.click('#users-add-open'); await wait(400);
  await page.type('#ua-first', 'Kim'); await page.type('#ua-email', 'kim@example.com');
  await page.click('#ua-generate');
  await page.select('#ua-plan', 'trial'); await page.select('#ua-team', '9');
  await page.click('#users-add button[type=submit]'); await wait(500);
  assert.equal(created.email, 'kim@example.com'); assert.equal(created.plan, 'trial'); assert.equal(created.teamId, 9);
  assert.ok(created.password.length >= 12, 'generated password');
  assert.match(await page.$eval('#ua-msg', e => e.textContent), /Created kim@example\.com and added to Acme Legal/);
  assert.deepEqual(page.errors, []);
});

await test('cloud: import from Dropbox and Drive into a tool, save results to Drive, recent files recorded', async () => {
  const pdf = fs.readFileSync(PDF3);
  let uploaded = null;
  const stubs = {
    'https://www.dropbox.com/static/api/2/dropins.js': `window.Dropbox={choose:function(o){o.success([{name:'from-dropbox.pdf',link:'https://dl.dropboxusercontent.com/s/abc/from-dropbox.pdf'}]);}};`,
    'https://accounts.google.com/gsi/client': `window.google=window.google||{};google.accounts={oauth2:{initTokenClient:function(c){return{requestAccessToken:function(){c.callback({access_token:'gtoken'});}};}}};`,
    'https://apis.google.com/js/api.js': `window.gapi={load:function(n,cb){cb();}};window.google=window.google||{};google.picker={ViewId:{DOCS:1},Action:{PICKED:'picked'},DocsView:function(){this.setMimeTypes=function(){return this;};},PickerBuilder:function(){var cb;this.addView=function(){return this;};this.setOAuthToken=function(){return this;};this.setDeveloperKey=function(){return this;};this.setCallback=function(f){cb=f;return this;};this.build=function(){return{setVisible:function(){cb({action:'picked',docs:[{id:'f1',name:'from-drive.pdf',mimeType:'application/pdf'}]});}};};}};`,
  };
  const page = await newPage(browser, baseApi(), (url, r) => {
    if (stubs[url]) return { status: 200, contentType: 'text/javascript', body: stubs[url] };
    if (url.startsWith('https://dl.dropboxusercontent.com/') || url.startsWith('https://www.googleapis.com/drive/v3/files/f1')) return { status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, contentType: 'application/pdf', body: pdf };
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files')) { if (r.method() === 'POST') uploaded = r.headers().authorization; return { status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, contentType: 'application/json', body: '{"id":"n1"}' }; }
    return null;
  });
  await page.evaluateOnNewDocument(() => { Object.defineProperty(window, 'NYX_CLOUD', { configurable: true, get: () => ({ googleClientId: 'cid', googleApiKey: 'key', dropboxAppKey: 'dbx' }), set: () => {} }); });
  await page.goto(`${SITE}/dashboard.html#split`, { waitUntil: 'networkidle2' }); await wait(1000);
  const buttons = await page.$$eval('#panel-split .cloud-import button', b => b.map(x => x.textContent));
  assert.deepEqual(buttons, ['Google Drive', 'Dropbox']);
  await page.click('#panel-split .cloud-import button:nth-of-type(2)'); await wait(1500);
  assert.match(await page.$eval('#split-file-list', e => e.innerText), /from-dropbox\.pdf/);
  await openPanel(page, 'compress');
  await page.click('#panel-compress .cloud-import button:nth-of-type(1)'); await wait(1500);
  assert.match(await page.$eval('#compress-file-list', e => e.innerText), /from-drive\.pdf/);
  await page.click('#compress-run'); await wait(4000);
  const saveBtn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Save to Google Drive'));
  assert.ok(await saveBtn.evaluate(b => b && b.offsetParent !== null), 'Save to Google Drive offered after download');
  await saveBtn.click(); await wait(800);
  assert.equal(uploaded, 'Bearer gtoken');
  const recents = await page.evaluate(() => JSON.parse(localStorage.getItem('nyx_recents_v1') || '[]'));
  assert.ok(recents.length >= 1, 'recent files recorded');
  assert.deepEqual(page.errors, []);
});

await test('signer journey against the real API: draw, sign in order, completed copy with certificate', async () => {
  const work = path.join(REPO, 'e2e', '.work');
  const { pool, fb, dir } = await backendCopy(work);
  const signRouter = (await import(pathToFileURL(path.join(dir, 'routes/sign-requests.js')).href)).default;
  const owner = fb.addFake('owner@example.com');
  await pool.query(`INSERT INTO users (firebase_uid,email,plan,subscription_status) VALUES ($1,'owner@example.com','professional','active')`, [owner]);
  const app = express();
  app.set('trust proxy', 1);
  app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); if (req.method === 'OPTIONS') return res.end(); next(); });
  app.use(express.json({ limit: '12mb' }));
  app.use('/api/sign-requests', signRouter);
  const api = await new Promise(r => { const s = app.listen(5702, () => r(s)); });
  const signerSite = await startSite(5703, 'http://localhost:5702');
  try {
    const created = await (await fetch('http://localhost:5702/api/sign-requests', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + owner }, body: JSON.stringify({
      title: 'Agreement', documentName: 'agreement.pdf', documentBase64: fs.readFileSync(PDF2).toString('base64'), sendNow: true,
      recipients: [{ name: 'Alice', email: 'alice@example.com' }, { name: 'Bob', email: 'bob@example.com' }],
      fields: [{ type: 'signature', assignedTo: 'alice@example.com', pageNumber: 1, x: .1, y: .8, width: .3, height: .07 }, { type: 'initials', assignedTo: 'bob@example.com', pageNumber: 2, x: .1, y: .8, width: .12, height: .06 }],
    }) })).json();
    const tokens = (await pool.query('SELECT token FROM signature_recipients WHERE request_id=$1 ORDER BY role_order', [created.request.id])).rows.map(r => r.token);
    const page = await newPage(browser, null);
    const open = t => page.goto(`http://localhost:5703/sign-request.html?token=${t}`, { waitUntil: 'networkidle2' });
    await open(tokens[1]); await wait(600);
    assert.match(await page.$eval('#fatal-title', e => e.textContent), /Not your turn/);
    await open(tokens[0]); await wait(1200);
    await page.click('#start-btn'); await wait(400); await page.click('#next-field'); await wait(400);
    const pad = await (await page.$('#sig-pad')).boundingBox();
    await page.mouse.move(pad.x + 30, pad.y + 110); await page.mouse.down();
    for (let i = 0; i < 30; i++) await page.mouse.move(pad.x + 30 + i * 10, pad.y + 100 - Math.sin(i / 3) * 35);
    await page.mouse.up();
    await page.click('#modal-save'); await wait(400);
    await page.click('#to-finish'); await wait(300); await page.click('#sign-consent'); await page.click('#complete-btn'); await wait(1200);
    assert.match(await page.$eval('#done-title', e => e.textContent), /signed/);
    await open(tokens[1]); await wait(1200);
    await page.click('#start-btn'); await wait(400); await page.click('#next-field'); await wait(400);
    await page.click('.tab[data-mode="type"]'); await page.click('#modal-save'); await wait(400);
    await page.click('#to-finish'); await wait(300); await page.click('#sign-consent'); await page.click('#complete-btn'); await wait(1500);
    await open(tokens[0]); await wait(800);
    assert.match(await page.$eval('#done-title', e => e.textContent), /complete/);
    const final = await fetch(`http://localhost:5702/api/sign-requests/public/${tokens[0]}/final-pdf`);
    assert.equal(final.status, 200);
    const pdf = await PDFDocument.load(Buffer.from(await final.arrayBuffer()));
    assert.equal(pdf.getPageCount(), 3, '2 pages + certificate');
    const stored = (await pool.query("SELECT value_text FROM signature_fields ORDER BY id")).rows.map(r => r.value_text.slice(0, 22));
    assert.deepEqual(stored, ['data:image/png;base64,', 'data:image/png;base64,']);
    assert.deepEqual(page.errors, []);
  } finally {
    api.close(); signerSite.close();
  }
});

await test('password-protected distribution link: prompt, wrong password, then opens', async () => {
  const { pool, fb, dir } = await backendCopy(path.join(REPO, 'e2e', '.work-dist'));
  const distRouter = (await import(pathToFileURL(path.join(dir, 'routes/distributions.js')).href)).default;
  const owner = fb.addFake('sender@example.com');
  await pool.query(`INSERT INTO users (firebase_uid,email,plan,subscription_status) VALUES ($1,'sender@example.com','professional','active')`, [owner]);
  const app = express();
  app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Document-Password'); if (req.method === 'OPTIONS') return res.end(); next(); });
  app.use(express.json({ limit: '12mb' }));
  app.use('/api/distributions', distRouter);
  const api = await new Promise(r => { const s = app.listen(5704, () => r(s)); });
  const recipientSite = await startSite(5705, 'http://localhost:5704');
  try {
    const res = await fetch('http://localhost:5704/api/distributions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + owner }, body: JSON.stringify({
      title: 'Board pack', documentName: 'board.pdf', documentBase64: fs.readFileSync(PDF2).toString('base64'), sendNow: true, expiresDays: 7, password: 'open-sesame',
      recipients: [{ name: 'Rita', email: 'rita@example.com' }] }) });
    assert.equal(res.status, 201);
    const { rows } = await pool.query("SELECT r.token, b.expires_at, b.access_password_hash FROM distribution_recipients r JOIN distribution_batches b ON b.id = r.batch_id");
    assert.match(rows[0].access_password_hash, /^scrypt:/, 'password stored hashed');
    const days = (new Date(rows[0].expires_at) - Date.now()) / 86400000;
    assert.ok(days > 6.9 && days < 7.1, 'expires in 7 days');
    const page = await newPage(browser, null);
    await page.goto(`http://localhost:5705/distribution.html?token=${rows[0].token}`, { waitUntil: 'networkidle2' }); await wait(600);
    assert.ok(await page.$('#pw-input'), 'asks for the password');
    await page.type('#pw-input', 'wrong'); await page.click('#pw-box button'); await wait(500);
    assert.match(await page.$eval('#result', e => e.textContent), /9 attempts left/);
    await page.$eval('#pw-input', e => { e.value = ''; }); await page.type('#pw-input', 'open-sesame'); await page.click('#pw-box button'); await wait(1200);
    assert.equal(await page.$('#pw-box'), null, 'password box removed');
    assert.equal(await page.$eval('#doc-title', e => e.textContent), 'Board pack');
    const opened = (await pool.query('SELECT status, failed_password_attempts FROM distribution_recipients')).rows[0];
    assert.deepEqual([opened.status, opened.failed_password_attempts], ['opened', 0]);
    assert.deepEqual(page.errors, []);
  } finally { api.close(); recipientSite.close(); }
});

await test('no critical or serious accessibility issues (axe, WCAG 2 A/AA)', async () => {
  const axe = fs.readFileSync(path.join(REPO, 'e2e', 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
  const api = (m, p) => (p === '/api/user/me' ? PRO_ME : p === '/api/admin/me' ? { email: 'owner@example.com', owner: true }
    : p === '/api/admin/stats' ? { plans: [], signupsDaily: [{ day: '2026-09-01', count: 0 }], signRequests: [], distributions: {}, funnel30d: {} } : {});
  const problems = [];
  for (const p of ['/', '/tools', '/split-pdf', '/login.html', '/contact.html', '/dashboard.html', '/dashboard.html#signrequest', '/dashboard.html#account', '/admin.html']) {
    const page = await newPage(browser, api);
    await page.goto(SITE + p, { waitUntil: 'networkidle2' }); await wait(900);
    await page.addScriptTag({ content: axe });
    const found = await page.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] })).violations
      .filter(v => ['critical', 'serious'].includes(v.impact)).map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(', ')}`));
    found.forEach(f => problems.push(`${p} ${f}`));
    await page.close();
  }
  assert.deepEqual(problems, []);
});

await browser.close(); site.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
