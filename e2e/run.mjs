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

await browser.close(); site.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
