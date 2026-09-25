// Shared helpers: serve docs/ with Firebase stubbed, drive Chrome, mock or run the API.
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import puppeteer from 'puppeteer';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..');
const DOCS = path.join(REPO, 'docs');
const PROD_API = 'https://nyxprism-production.up.railway.app';
export const wait = ms => new Promise(r => setTimeout(r, ms));

const STUBS = {
  'app.js': 'export const initializeApp = () => ({});',
  'auth.js': `const user = { uid: 'u1', email: 'tester@example.com', emailVerified: true, getIdToken: async () => 'tok' };
const auth = { currentUser: user };
export const getAuth = () => auth;
export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb(user), 30); return () => {}; };
export const signInWithEmailAndPassword = async () => ({ user }); export const createUserWithEmailAndPassword = async () => ({ user });
export const sendPasswordResetEmail = async () => {}; export const signOut = async () => {};
export const EmailAuthProvider = { credential: () => ({}) }; export const reauthenticateWithCredential = async () => {};
export const updatePassword = async () => {}; export const verifyBeforeUpdateEmail = async () => {};
export const sendEmailVerification = async () => {}; export const reload = async () => {};`,
  'fs.js': 'export const getFirestore = () => ({}); export const doc = () => ({}); export const getDoc = async () => ({ exists: () => false }); export const setDoc = async () => {}; export const serverTimestamp = () => null;',
};
const TYPES = { html: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', webp: 'image/webp', png: 'image/png', ico: 'image/x-icon', json: 'application/json', svg: 'image/svg+xml' };

/** Serve docs/ like Vercel does (clean URLs), with Firebase swapped for local stubs and the API pointed at apiBase. */
export function startSite(port, apiBase = PROD_API) {
  const server = http.createServer((req, res) => {
    let url = decodeURIComponent(req.url.split('?')[0]);
    if (url.startsWith('/__stubs/')) { res.setHeader('Content-Type', 'text/javascript'); return res.end(STUBS[url.slice(9)] || ''); }
    if (url === '/') url = '/index.html';
    let file = path.join(DOCS, url);
    if (!path.extname(file)) file += '.html';
    if (!file.startsWith(DOCS) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
    let body = fs.readFileSync(file);
    if (file.endsWith('config.js')) body = body.toString().replaceAll(PROD_API, apiBase);
    if (/\.(html|mjs)$/.test(file)) {
      body = body.toString()
        .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-app\.js/g, '/__stubs/app.js')
        .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-auth\.js/g, '/__stubs/auth.js')
        .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-firestore\.js/g, '/__stubs/fs.js')
        .replaceAll(PROD_API, apiBase);
    }
    res.setHeader('Content-Type', TYPES[path.extname(file).slice(1)] || 'application/octet-stream');
    res.end(body);
  });
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

export async function launch() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  return browser;
}

/** New page that records page errors and answers API calls with handler(method, path, body). */
export async function newPage(browser, handler = () => ({}), external = null) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 1000 });
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('dialog', d => (d.type() === 'prompt' ? d.accept('E2E template') : d.accept()));
  if (handler || external) {
    handler = handler || (() => ({}));
    await page.setRequestInterception(true);
    page.on('request', r => {
      const url = r.url();
      const ext = external && external(url, r);
      if (ext) return r.respond(ext);
      if (!url.startsWith(PROD_API)) return r.continue();
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
      if (r.method() === 'OPTIONS') return r.respond({ status: 204, headers: cors });
      const p = new URL(url).pathname;
      let body = null; try { body = r.postData() ? JSON.parse(r.postData()) : null; } catch { /* non-JSON */ }
      const out = handler(r.method(), p, body);
      const [status, json] = Array.isArray(out) ? out : [200, out ?? {}];
      r.respond({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(json) });
    });
  }
  return page;
}

export const PRO_ME = { email: 'tester@example.com', first_name: 'Tess', plan: 'professional', subscription_status: 'active', created_at: new Date().toISOString() };

export async function makePdf(file, pages = 3) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage([612, 792]).drawText(`Page ${i}`, { x: 72, y: 700, size: 24, font });
  fs.writeFileSync(file, await doc.save());
  return file;
}

export async function openPanel(page, name) {
  await page.evaluate(n => document.querySelector(`.nav-item[data-panel="${n}"]`)?.click(), name);
  await wait(400);
}

export async function dropFile(page, selector, file, name = path.basename(file), type = 'application/pdf') {
  const b64 = fs.readFileSync(file).toString('base64');
  await page.evaluate((sel, n, t, data) => {
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bytes], n, { type: t }));
    document.querySelector(sel).dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, selector, name, type, b64);
}

/** Copy backend/src into a work dir with Postgres (PGlite, in memory) and Firebase replaced by fakes. */
export async function backendCopy(work) {
  fs.rmSync(work, { recursive: true, force: true });
  fs.cpSync(path.join(REPO, 'backend', 'src'), path.join(work, 'src'), { recursive: true });
  fs.writeFileSync(path.join(work, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(work, 'src/db/index.js'), `import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const pool = { query: (t, p) => db.query(t, p || []), exec: t => db.exec(t), connect: async () => ({ query: (t, p) => db.query(t, p || []), release() {} }) };
export default pool;`);
  fs.writeFileSync(path.join(work, 'src/firebase.js'), `export const users = new Map(); let n = 0;
export function addFake(email, extra = {}) { const uid = 'uid' + (++n); users.set(uid, { uid, email, emailVerified: true, ...extra }); return uid; }
const auth = { verifyIdToken: async t => { const u = users.get(t); if (!u) throw new Error('bad token'); return { uid: u.uid, email: u.email, email_verified: !!u.emailVerified }; } };
export default { auth: () => auth };`);
  const pool = (await import(pathToFileURL(path.join(work, 'src/db/index.js')).href)).default;
  await pool.exec(fs.readFileSync(path.join(work, 'src/db/schema.sql'), 'utf8'));
  return { pool, fb: await import(pathToFileURL(path.join(work, 'src/firebase.js')).href), dir: path.join(work, 'src') };
}
