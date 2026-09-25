import { Router } from 'express';
import { createHash, randomBytes } from 'crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import pool from '../db/index.js';
import { requireActivePlan, requireAuth, requireVerifiedEmail } from '../middleware/auth.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELD_TYPES = new Set(['signature', 'initials', 'name', 'date', 'text', 'checkbox']);
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_USER_DOCUMENT_BYTES = 100 * 1024 * 1024;
const REQUEST_DAYS = 30;
const TOKEN_RE = /^[a-f0-9]{64}$/;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

async function sendEmail({ to, subject, html }) {
  if (!process.env.BREVO_API_KEY) throw new Error('BREVO_API_KEY is not configured.');
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'NyxPrism Signatures', email: 'info@nyxprism.com' },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  if (!res.ok) throw new Error(`Brevo error ${res.status}`);
}

async function recordNotification(clientOrPool, { requestId, recipientId = null, type, status, error = null }) {
  await clientOrPool.query(
    `INSERT INTO signature_notifications (request_id, recipient_id, notification_type, status, error)
     VALUES ($1, $2, $3, $4, $5)`,
    [requestId, recipientId, type, status, error],
  );
}

const APP_PUBLIC = () => (process.env.FRONTEND_URL || 'https://www.nyxprism.com').replace(/\/$/, '');
const signingUrl = token => `${APP_PUBLIC()}/sign-request?token=${encodeURIComponent(token)}`;
const API_PUBLIC = () => (process.env.PUBLIC_API_URL || 'https://nyxprism-production.up.railway.app').replace(/\/$/, '');

/** The sender's branding (company name, hosted logo URL), if they set one. */
export async function brandFor(userId) {
  if (!userId) return null;
  const { rows } = await pool.query('SELECT id, brand_name, (brand_logo IS NOT NULL) AS has_logo FROM users WHERE id = $1', [userId]);
  const row = rows[0];
  if (!row || (!row.brand_name && !row.has_logo)) return null;
  return { name: row.brand_name || null, logoUrl: row.has_logo ? `${API_PUBLIC()}/api/user/brand/${row.id}/logo` : null };
}

function brandHeader(brand) {
  if (!brand) return '';
  const logo = brand.logoUrl ? `<img src="${brand.logoUrl}" alt="${escapeHtml(brand.name || '')}" style="max-height:48px;max-width:200px;display:block;margin-bottom:12px">` : '';
  const name = !brand.logoUrl && brand.name ? `<p style="font-size:18px;font-weight:700;margin:0 0 12px">${escapeHtml(brand.name)}</p>` : '';
  return logo + name;
}

function signerEmailHtml({ signer, title, documentName, message, ownerEmail, brand = null, reminder = false }) {
  const from = brand?.name ? `${brand.name} (${ownerEmail})` : (ownerEmail || 'NyxPrism');
  return `${brandHeader(brand)}<p>Hello ${escapeHtml(signer.name)},</p><p>${reminder ? 'A reminder: ' : ''}${escapeHtml(from)} requested your signature on <strong>${escapeHtml(documentName)}</strong>.</p>${message ? `<p style="white-space:pre-wrap;">${escapeHtml(message)}</p>` : ''}<p><a href="${signer.url}">Review and sign the document</a></p><p>This secure link is unique to you.</p>`;
}

async function audit(clientOrPool, { requestId, recipientId = null, eventType, detail = null, req = null }) {
  await clientOrPool.query(
    `INSERT INTO signature_audit_events (request_id, recipient_id, event_type, detail, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [requestId, recipientId, eventType, detail, req?.ip || null, req?.headers?.['user-agent'] || null],
  );
}

function normalizeDocument(body) {
  const raw = String(body?.documentBase64 || '').trim();
  if (!raw) throw new Error('PDF document is required.');
  const base64 = raw.includes(',') ? raw.split(',').pop() : raw;
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length || buffer.length > MAX_DOCUMENT_BYTES) throw new Error('PDF must be 8 MB or smaller.');
  if (buffer.slice(0, 4).toString() !== '%PDF') throw new Error('Document must be a PDF.');
  return buffer;
}

async function findOrCreateUser(user) {
  const existing = await pool.query(
    'SELECT id FROM users WHERE firebase_uid = $1 OR email = $2 LIMIT 1',
    [user.uid, user.email],
  );
  if (existing.rows.length) return existing.rows[0].id;

  const created = await pool.query(
    `INSERT INTO users (firebase_uid, email, plan, subscription_status, trial_active, trial_start)
     VALUES ($1, $2, 'free', 'active', FALSE, NULL)
     ON CONFLICT (email) DO UPDATE SET firebase_uid = EXCLUDED.firebase_uid
     RETURNING id`,
    [user.uid, user.email],
  );
  return created.rows[0].id;
}

function normalizeRecipients(recipients) {
  if (!Array.isArray(recipients) || recipients.length < 1) {
    throw new Error('At least one recipient is required.');
  }
  if (recipients.length > 10) throw new Error('Maximum 10 recipients per request.');

  return recipients.map((recipient, index) => {
    const name = String(recipient.name || '').trim().slice(0, 120);
    const email = String(recipient.email || '').trim().toLowerCase().slice(0, 254);
    if (!name || !EMAIL_RE.test(email)) throw new Error('Each recipient needs a valid name and email.');
    return { name, email, roleOrder: index + 1 };
  });
}

function normalizeFields(fields, recipients) {
  if (!Array.isArray(fields) || fields.length < 1) throw new Error('Add at least one field.');
  if (fields.length > 200) throw new Error('Maximum 200 fields per request.');

  const recipientEmails = new Set(recipients.map(recipient => recipient.email));
  return fields.map(field => {
    const type = String(field.type || '').toLowerCase();
    const assignedTo = String(field.assignedTo || '').trim().toLowerCase();
    if (!FIELD_TYPES.has(type)) throw new Error('Invalid field type.');
    if (!recipientEmails.has(assignedTo)) throw new Error('Each field must be assigned to a recipient.');

    return {
      type,
      assignedTo,
      pageNumber: Math.max(1, Math.min(10000, parseInt(field.pageNumber, 10) || 1)),
      x: Math.max(0, Math.min(1, Number(field.x) || 0)),
      y: Math.max(0, Math.min(1, Number(field.y) || 0)),
      width: Math.max(0.02, Math.min(1, Number(field.width) || 0.22)),
      height: Math.max(0.02, Math.min(1, Number(field.height) || 0.06)),
      required: field.required !== false,
      label: String(field.label || type).trim().slice(0, 80),
    };
  });
}

const SIGNATURE_IMAGE_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const MAX_SIGNATURE_IMAGE_CHARS = 300_000;
const IMAGE_FIELD_TYPES = new Set(['signature', 'initials']);

// Signature and initials fields may hold a drawn PNG; everything else is text.
function normalizeFieldValue(fieldType, raw) {
  const value = String(raw || '').trim();
  if (IMAGE_FIELD_TYPES.has(fieldType) && value.startsWith('data:image/')) {
    if (value.length > MAX_SIGNATURE_IMAGE_CHARS || !SIGNATURE_IMAGE_RE.test(value)) return null;
    const bytes = Buffer.from(value.split(',')[1], 'base64');
    if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) return null; // PNG signature
    return value;
  }
  return value.slice(0, 1000);
}

// The built-in PDF fonts only encode Latin-1; anything else would make pdf-lib throw.
function pdfSafe(text) {
  return String(text).replace(/[^ -~ -ÿ]/g, '?');
}

function formatUtc(date) {
  return date ? new Date(date).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '-';
}

/** Builds the completed PDF: every signer's values applied, plus a certificate of completion page. */
async function buildFinalPdf(requestId) {
  const requestResult = await pool.query(
    `SELECT r.id, r.title, r.document_name, r.document_data, r.document_hash, r.created_at, r.sent_at, r.completed_at, u.email AS owner_email
     FROM signature_requests r JOIN users u ON u.id = r.owner_user_id WHERE r.id = $1`,
    [requestId],
  );
  const request = requestResult.rows[0];
  const [fields, signers] = await Promise.all([
    pool.query(
      `SELECT field_type, page_number, x, y, width, height, value_text
       FROM signature_fields WHERE request_id = $1 AND value_text IS NOT NULL AND value_text != ''
       ORDER BY page_number, id`,
      [requestId],
    ),
    pool.query(
      `SELECT sr.name, sr.email, sr.role_order, sr.status, sr.viewed_at, sr.completed_at, sr.completion_hash,
              (SELECT e.ip_address FROM signature_audit_events e
               WHERE e.recipient_id = sr.id AND e.event_type = 'completed' ORDER BY e.created_at DESC LIMIT 1) AS ip_address
       FROM signature_recipients sr WHERE sr.request_id = $1 ORDER BY sr.role_order, sr.id`,
      [requestId],
    ),
  ]);

  const doc = await PDFDocument.load(Buffer.from(request.document_data), { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  const ink = rgb(0.08, 0.09, 0.12);
  for (const field of fields.rows) {
    const page = pages[Number(field.page_number) - 1];
    if (!page) continue;
    const { width, height } = page.getSize();
    const boxWidth = Number(field.width) * width;
    const boxHeight = Number(field.height) * height;
    const left = Number(field.x) * width;
    const bottom = height - (Number(field.y) * height) - boxHeight;
    const value = String(field.value_text || '');
    if (IMAGE_FIELD_TYPES.has(field.field_type) && value.startsWith('data:image/png;base64,')) {
      const image = await doc.embedPng(Buffer.from(value.split(',')[1], 'base64'));
      const scale = Math.min(boxWidth / image.width, boxHeight / image.height);
      const drawWidth = image.width * scale;
      const drawHeight = image.height * scale;
      page.drawImage(image, { x: left + (boxWidth - drawWidth) / 2, y: bottom + (boxHeight - drawHeight) / 2, width: drawWidth, height: drawHeight });
      continue;
    }
    const text = field.field_type === 'checkbox' ? 'X' : value;
    const fontSize = Math.max(9, Math.min(18, boxHeight * 0.52));
    page.drawText(pdfSafe(text), { x: left + 4, y: bottom + 4, size: fontSize, font, color: ink });
  }

  // Certificate of completion
  const cert = doc.addPage([612, 792]);
  const muted = rgb(0.35, 0.38, 0.45);
  let y = 740;
  const line = (text, opts = {}) => {
    cert.drawText(pdfSafe(text), { x: opts.x ?? 56, y, size: opts.size ?? 10, font: opts.bold ? bold : font, color: opts.color ?? ink });
    y -= opts.gap ?? 15;
  };
  line('Certificate of Completion', { size: 18, bold: true, gap: 26 });
  line(`Document: ${request.title}`, { bold: true });
  line(`File: ${request.document_name}`);
  line(`Sent by: ${request.owner_email}`);
  line(`Sent: ${formatUtc(request.sent_at || request.created_at)}    Completed: ${formatUtc(request.completed_at)}`);
  line(`Original document SHA-256: ${request.document_hash || '-'}`, { size: 8, color: muted, gap: 26 });
  line('Signers', { size: 13, bold: true, gap: 20 });
  for (const signer of signers.rows) {
    if (y < 110) break;
    line(`${signer.role_order}. ${signer.name} <${signer.email}>`, { bold: true });
    line(`Status: ${signer.status}    Viewed: ${formatUtc(signer.viewed_at)}    Signed: ${formatUtc(signer.completed_at)}`, { x: 70 });
    line(`IP address: ${signer.ip_address || '-'}`, { x: 70 });
    line(`Signature record SHA-256: ${signer.completion_hash || '-'}`, { x: 70, size: 8, color: muted, gap: 20 });
  }
  y = Math.min(y, 90);
  line('Each signer consented to use electronic records and signatures before signing.', { size: 8, color: muted, gap: 12 });
  line('Generated by NyxPrism (nyxprism.com). The full audit trail is retained with the signature request.', { size: 8, color: muted });

  return { bytes: Buffer.from(await doc.save()), request };
}

async function sendFinalPdf(res, requestId, req, eventType, recipientId = null) {
  const { bytes, request } = await buildFinalPdf(requestId);
  const finalHash = createHash('sha256').update(bytes).digest('hex');
  await audit(pool, { requestId, recipientId, eventType, detail: `SHA-256 ${finalHash}`, req });
  const fileName = String(request.document_name || 'signed-document.pdf').replace(/\.pdf$/i, '') + '-completed.pdf';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
  res.setHeader('X-Document-SHA256', finalHash);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.send(bytes);
}

async function requestSummary(requestId) {
  const { rows } = await pool.query(
    'SELECT r.title, r.document_name, u.email AS owner_email FROM signature_requests r JOIN users u ON u.id = r.owner_user_id WHERE r.id = $1',
    [requestId],
  );
  return rows[0];
}

async function sendLogged(requestId, recipientId, type, message) {
  try {
    await sendEmail(message);
    await recordNotification(pool, { requestId, recipientId, type, status: 'sent' });
  } catch (err) {
    await recordNotification(pool, { requestId, recipientId, type, status: 'failed', error: err.message }).catch(() => {});
  }
}

/** After the last signature: tell the sender, and give every signer a link to the completed copy. */
async function notifyCompleted(requestId) {
  const request = await requestSummary(requestId);
  const signers = await pool.query('SELECT id, name, email, token FROM signature_recipients WHERE request_id = $1 ORDER BY role_order, id', [requestId]);
  const base = APP_PUBLIC();
  await Promise.all([
    sendLogged(requestId, null, 'owner_completed', {
      to: request.owner_email,
      subject: `Completed: ${request.title}`,
      html: `<p>Everyone has signed <strong>${escapeHtml(request.document_name)}</strong>.</p><p><a href="${base}/dashboard.html">Open NyxPrism</a> to download the completed PDF with its certificate of completion.</p>`,
    }),
    ...signers.rows.map(signer => sendLogged(requestId, signer.id, 'signer_completed_copy', {
      to: signer.email,
      subject: `Your signed copy: ${request.title}`,
      html: `<p>Hello ${escapeHtml(signer.name)},</p><p>All parties have signed <strong>${escapeHtml(request.document_name)}</strong>.</p><p><a href="${signingUrl(signer.token)}">Download the completed document</a></p><p>This link is unique to you.</p>`,
    })),
  ]);
}

async function notifyDeclined(requestId, signerName, reason) {
  const request = await requestSummary(requestId);
  await sendLogged(requestId, null, 'owner_declined', {
    to: request.owner_email,
    subject: `Declined: ${request.title}`,
    html: `<p>${escapeHtml(signerName)} declined to sign <strong>${escapeHtml(request.document_name)}</strong>.</p>${reason ? `<p>Reason: ${escapeHtml(reason)}</p>` : ''}<p>The request is closed. You can send a new one from NyxPrism.</p>`,
  });
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = await findOrCreateUser(req.user);
    const result = await pool.query(
      `SELECT id, title, document_name, status, created_at, sent_at, completed_at, expires_at
       FROM signature_requests
       WHERE owner_user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId],
    );
    res.json({ requests: result.rows });
  } catch (err) {
    console.error('sign-requests GET error:', err.message);
    res.status(500).json({ error: 'Failed to load signature requests.' });
  }
});

router.get('/alerts', requireAuth, async (req, res) => {
  const windowDays = Math.max(1, Math.min(365, parseInt(req.query.windowDays, 10) || 30));
  const upcomingDays = Math.max(1, Math.min(windowDays, parseInt(req.query.upcomingDays, 10) || 7));
  try {
    const userId = await findOrCreateUser(req.user);
    await pool.query(
      `UPDATE signature_requests SET status = 'expired', updated_at = NOW()
       WHERE owner_user_id = $1 AND expires_at < NOW() AND status NOT IN ('completed','declined','expired')`,
      [userId],
    );
    const result = await pool.query(
      `SELECT r.id, r.title, r.document_name, r.status, r.expires_at,
              CEIL(EXTRACT(EPOCH FROM (r.expires_at - NOW())) / 86400)::int AS days_remaining,
              a.acknowledged_at
       FROM signature_requests r
       LEFT JOIN signature_alert_acknowledgements a ON a.request_id = r.id AND a.user_id = $1
       WHERE r.owner_user_id = $1
         AND r.expires_at IS NOT NULL
         AND r.status NOT IN ('completed','declined')
         AND r.expires_at <= NOW() + ($2 || ' days')::interval
       ORDER BY r.expires_at ASC`,
      [userId, windowDays],
    );
    res.json({
      alerts: result.rows.map(row => ({
        ...row,
        severity: row.status === 'expired' || row.days_remaining <= 0 ? 'expired' : row.days_remaining <= upcomingDays ? 'upcoming' : 'notice',
        acknowledged: Boolean(row.acknowledged_at),
      })),
      windowDays,
      upcomingDays,
    });
  } catch (err) {
    console.error('sign-requests alerts error:', err.message);
    res.status(500).json({ error: 'Failed to load alerts.' });
  }
});

router.post('/alerts/:id/ack', requireAuth, async (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  if (!Number.isInteger(requestId) || requestId < 1) return res.status(400).json({ error: 'Invalid request ID.' });
  try {
    const userId = await findOrCreateUser(req.user);
    const owns = await pool.query('SELECT id FROM signature_requests WHERE id = $1 AND owner_user_id = $2', [requestId, userId]);
    if (!owns.rows.length) return res.status(404).json({ error: 'Alert not found.' });
    await pool.query(
      `INSERT INTO signature_alert_acknowledgements (request_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (request_id, user_id) DO UPDATE SET acknowledged_at = NOW()`,
      [requestId, userId],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('sign-requests ack error:', err.message);
    res.status(500).json({ error: 'Failed to acknowledge alert.' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  if (!Number.isInteger(requestId) || requestId < 1) return res.status(400).json({ error: 'Invalid request ID.' });
  try {
    const userId = await findOrCreateUser(req.user);
    const requestResult = await pool.query(
      `SELECT id, title, document_name, message, status, created_at, sent_at, completed_at, expires_at
       FROM signature_requests
       WHERE id = $1 AND owner_user_id = $2`,
      [requestId, userId],
    );
    if (!requestResult.rows.length) return res.status(404).json({ error: 'Signature request not found.' });
    const recipients = await pool.query(
      `SELECT id, name, email, role_order, token, status, viewed_at, completed_at, declined_at, decline_reason
       FROM signature_recipients
       WHERE request_id = $1
       ORDER BY role_order, id`,
      [requestId],
    );
    const events = await pool.query(
      `SELECT event_type, detail, created_at
       FROM signature_audit_events
       WHERE request_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [requestId],
    );
    const request = requestResult.rows[0];
    res.json({
      request,
      recipients: recipients.rows.map(row => ({ ...row, ...(request.status !== 'draft' ? { url: signingUrl(row.token) } : {}) })),
      events: events.rows,
    });
  } catch (err) {
    console.error('sign-requests detail error:', err.message);
    res.status(500).json({ error: 'Failed to load signature request.' });
  }
});

router.get('/:id/final-pdf', requireAuth, async (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  if (!Number.isInteger(requestId) || requestId < 1) return res.status(400).json({ error: 'Invalid request ID.' });
  try {
    const userId = await findOrCreateUser(req.user);
    const owns = await pool.query('SELECT id, status FROM signature_requests WHERE id = $1 AND owner_user_id = $2', [requestId, userId]);
    if (!owns.rows.length) return res.status(404).json({ error: 'Signature request not found.' });
    if (owns.rows[0].status !== 'completed') return res.status(409).json({ error: 'The final PDF is available after every signer completes.' });
    await sendFinalPdf(res, requestId, req, 'final_pdf_downloaded');
  } catch (err) {
    console.error('sign-requests final PDF error:', err.message);
    res.status(500).json({ error: 'Failed to generate final signed PDF.' });
  }
});

router.post('/', requireAuth, requireVerifiedEmail, requireActivePlan, async (req, res) => {
  let recipients;
  let fields;
  try {
    recipients = normalizeRecipients(req.body?.recipients);
    fields = normalizeFields(req.body?.fields, recipients);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const title = String(req.body?.title || 'Signature request').trim().slice(0, 160);
  const documentName = String(req.body?.documentName || 'document.pdf').trim().slice(0, 240);
  const message = String(req.body?.message || '').trim().slice(0, 2000) || null;
  const sendNow = req.body?.sendNow === true;
  const expiresAt = new Date(Date.now() + REQUEST_DAYS * 24 * 60 * 60 * 1000);
  let documentBuffer;
  try {
    documentBuffer = normalizeDocument(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const client = await pool.connect();
  let signers = [];
  let request;
  try {
    await client.query('BEGIN');
    const userId = await findOrCreateUser(req.user);
    const usageResult = await client.query(
      `SELECT COALESCE((SELECT SUM(document_size) FROM signature_requests WHERE owner_user_id = $1), 0) +
              COALESCE((SELECT SUM(document_size) FROM distribution_batches WHERE owner_user_id = $1), 0) AS bytes`,
      [userId],
    );
    if (Number(usageResult.rows[0].bytes) + documentBuffer.length > MAX_USER_DOCUMENT_BYTES) {
      await client.query('ROLLBACK');
      return res.status(413).json({ error: 'Document storage limit reached. Delete older workflows and try again.' });
    }
    const requestResult = await client.query(
      `INSERT INTO signature_requests (owner_user_id, title, document_name, document_mime, document_size, document_data, document_hash, message, status, expires_at)
       VALUES ($1, $2, $3, 'application/pdf', $4, $5, $6, $7, $8, $9)
       RETURNING id, title, document_name, status, created_at`,
      [userId, title, documentName, documentBuffer.length, documentBuffer, createHash('sha256').update(documentBuffer).digest('hex'), message, sendNow ? 'sent' : 'draft', expiresAt],
    );
    request = requestResult.rows[0];

    const recipientIds = new Map();
    for (const recipient of recipients) {
      const token = randomBytes(32).toString('hex');
      const recipientStatus = !sendNow ? 'draft' : recipient.roleOrder > 1 ? 'waiting' : 'pending';
      await client.query(
        `INSERT INTO saved_contacts (user_id, name, email, last_used_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, email)
         DO UPDATE SET name = EXCLUDED.name, last_used_at = NOW()`,
        [userId, recipient.name, recipient.email],
      );
      const inserted = await client.query(
        `INSERT INTO signature_recipients (request_id, name, email, role_order, token, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email`,
        [request.id, recipient.name, recipient.email, recipient.roleOrder, token, recipientStatus],
      );
      recipientIds.set(inserted.rows[0].email, inserted.rows[0].id);
      signers.push({ ...recipient, id: inserted.rows[0].id, status: recipientStatus, token, url: signingUrl(token) });
    }

    for (const field of fields) {
      await client.query(
        `INSERT INTO signature_fields
          (request_id, recipient_id, field_type, page_number, x, y, width, height, required, label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          request.id,
          recipientIds.get(field.assignedTo),
          field.type,
          field.pageNumber,
          field.x,
          field.y,
          field.width,
          field.height,
          field.required,
          field.label,
        ],
      );
    }

    if (sendNow) {
      await client.query('UPDATE signature_requests SET sent_at = NOW(), updated_at = NOW() WHERE id = $1', [request.id]);
      await audit(client, { requestId: request.id, eventType: 'sent', detail: `${signers.length} recipient(s)` });
    } else {
      await audit(client, { requestId: request.id, eventType: 'draft_created', detail: `${signers.length} recipient(s)` });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sign-requests POST error:', err.message);
    res.status(500).json({ error: 'Failed to create signature request.' });
    return;
  } finally {
    client.release();
  }

  let emailWarning = null;
  if (sendNow) {
    const brand = await brandFor((await findOrCreateUser(req.user))).catch(() => null);
    try {
      await Promise.all(signers.filter(signer => signer.status === 'pending').map(async signer => {
        try {
          await sendEmail({ to: signer.email, subject: `Signature requested: ${title}`, html: signerEmailHtml({ signer, title, documentName, message, ownerEmail: req.user.email, brand }) });
          await recordNotification(pool, { requestId: request.id, recipientId: signer.id, type: 'signature_request_sent', status: 'sent' });
        } catch (err) {
          await recordNotification(pool, { requestId: request.id, recipientId: signer.id, type: 'signature_request_sent', status: 'failed', error: err.message });
          throw err;
        }
      }));
    } catch (err) {
      emailWarning = `Signature request created, but the email to the first signer could not be delivered. Copy this signing link instead: ${signers.find(signer => signer.status === 'pending')?.url || 'Unavailable'}`;
      console.error('sign-requests email error:', err.message);
    }
  }

  res.status(201).json({
    request,
    signers: signers.map(({ name, email, url }) => ({ name, email, ...(sendNow ? { url } : {}) })),
    warning: emailWarning,
  });
});

router.post('/:id/send', requireAuth, requireVerifiedEmail, requireActivePlan, async (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  if (!Number.isInteger(requestId) || requestId < 1) return res.status(400).json({ error: 'Invalid request ID.' });
  const client = await pool.connect();
  let signer;
  try {
    await client.query('BEGIN');
    const userId = await findOrCreateUser(req.user);
    const requestResult = await client.query(
      `SELECT id, title, document_name, message
       FROM signature_requests
       WHERE id = $1 AND owner_user_id = $2 AND status = 'draft'
       FOR UPDATE`,
      [requestId, userId],
    );
    if (!requestResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Only an existing draft can be sent.' });
    }
    const request = requestResult.rows[0];
    const firstResult = await client.query(
      `SELECT id, name, email, token
       FROM signature_recipients
       WHERE request_id = $1
       ORDER BY role_order, id
       LIMIT 1`,
      [requestId],
    );
    if (!firstResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The draft has no recipients.' });
    }
    await client.query(
      `UPDATE signature_recipients
       SET status = CASE WHEN id = $2 THEN 'pending' ELSE 'waiting' END
       WHERE request_id = $1 AND status = 'draft'`,
      [requestId, firstResult.rows[0].id],
    );
    await client.query("UPDATE signature_requests SET status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $1", [requestId]);
    signer = {
      ...firstResult.rows[0],
      title: request.title,
      document_name: request.document_name,
      message: request.message,
      url: signingUrl(firstResult.rows[0].token),
    };
    await audit(client, { requestId, recipientId: signer.id, eventType: 'sent', detail: 'Draft sent', req });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('sign-requests send error:', error.message);
    return res.status(500).json({ error: 'Failed to send signature request.' });
  } finally {
    client.release();
  }

  let warning = null;
  try {
    const brand = await brandFor(await findOrCreateUser(req.user)).catch(() => null);
    await sendEmail({ to: signer.email, subject: `Signature requested: ${signer.title}`, html: signerEmailHtml({ signer, title: signer.title, documentName: signer.document_name, message: signer.message, ownerEmail: req.user.email, brand }) });
    await recordNotification(pool, { requestId, recipientId: signer.id, type: 'signature_request_sent', status: 'sent' });
  } catch (error) {
    warning = `Request activated, but the email could not be delivered. Copy this signing link instead: ${signer.url}`;
    await recordNotification(pool, { requestId, recipientId: signer.id, type: 'signature_request_sent', status: 'failed', error: error.message });
  }
  res.json({ ok: true, warning });
});


const REMINDER_EVERY_DAYS = 3;
const MAX_REMINDERS = 3;

/** Email the signer(s) whose turn it is. Returns how many reminders were sent. */
async function remindCurrentSigners(requestId) {
  const { rows } = await pool.query(
    `SELECT sr.id, sr.name, sr.email, sr.token, r.title, r.document_name, r.message, r.owner_user_id, u.email AS owner_email
     FROM signature_recipients sr
     JOIN signature_requests r ON r.id = sr.request_id
     JOIN users u ON u.id = r.owner_user_id
     WHERE sr.request_id = $1 AND sr.status = 'pending' AND r.status IN ('sent', 'in_progress')
       AND (r.expires_at IS NULL OR r.expires_at > NOW())`,
    [requestId],
  );
  let sent = 0;
  for (const signer of rows) {
    const url = signingUrl(signer.token);
    try {
      await sendEmail({
        to: signer.email,
        subject: `Reminder: signature requested - ${signer.title}`,
        html: signerEmailHtml({ signer: { ...signer, url }, title: signer.title, documentName: signer.document_name, message: signer.message, ownerEmail: signer.owner_email, brand: await brandFor(signer.owner_user_id).catch(() => null), reminder: true }),
      });
      await recordNotification(pool, { requestId, recipientId: signer.id, type: 'signature_reminder', status: 'sent' });
      await audit(pool, { requestId, recipientId: signer.id, eventType: 'reminder_sent' });
      sent++;
    } catch (err) {
      await recordNotification(pool, { requestId, recipientId: signer.id, type: 'signature_reminder', status: 'failed', error: err.message }).catch(() => {});
    }
  }
  return sent;
}

/** Automatic reminders: every few days to whoever's turn it is, a limited number of times. */
export async function runSignatureReminders() {
  const { rows } = await pool.query(
    `SELECT DISTINCT sr.request_id
     FROM signature_recipients sr
     JOIN signature_requests r ON r.id = sr.request_id
     WHERE sr.status = 'pending' AND r.status IN ('sent', 'in_progress')
       AND (r.expires_at IS NULL OR r.expires_at > NOW())
       AND (SELECT MAX(n.created_at) FROM signature_notifications n
            WHERE n.recipient_id = sr.id AND n.status = 'sent') < NOW() - ($1 || ' days')::interval
       AND (SELECT COUNT(*) FROM signature_notifications n
            WHERE n.recipient_id = sr.id AND n.notification_type = 'signature_reminder' AND n.status = 'sent') < $2`,
    [REMINDER_EVERY_DAYS, MAX_REMINDERS],
  );
  let sent = 0;
  for (const row of rows) sent += await remindCurrentSigners(row.request_id);
  return sent;
}

router.post('/:id/remind', requireAuth, async (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  if (!Number.isInteger(requestId) || requestId < 1) return res.status(400).json({ error: 'Invalid request ID.' });
  try {
    const userId = await findOrCreateUser(req.user);
    const owns = await pool.query("SELECT id FROM signature_requests WHERE id = $1 AND owner_user_id = $2 AND status IN ('sent', 'in_progress')", [requestId, userId]);
    if (!owns.rows.length) return res.status(409).json({ error: 'Only an active request can be reminded.' });
    const recent = await pool.query(
      `SELECT 1 FROM signature_notifications n JOIN signature_recipients sr ON sr.id = n.recipient_id
       WHERE n.request_id = $1 AND sr.status = 'pending' AND n.status = 'sent' AND n.created_at > NOW() - INTERVAL '1 hour' LIMIT 1`,
      [requestId],
    );
    if (recent.rows.length) return res.status(429).json({ error: 'The signer was emailed less than an hour ago. Try again later.' });
    const sent = await remindCurrentSigners(requestId);
    if (!sent) return res.status(502).json({ error: 'The reminder could not be sent. Check the signer’s email address.' });
    res.json({ ok: true, sent });
  } catch (err) {
    console.error('sign-requests remind error:', err.message);
    res.status(500).json({ error: 'Failed to send reminder.' });
  }
});

router.post('/:id/void', requireAuth, async (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  if (!Number.isInteger(requestId) || requestId < 1) return res.status(400).json({ error: 'Invalid request ID.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = await findOrCreateUser(req.user);
    const result = await client.query(
      `UPDATE signature_requests SET status = 'voided', updated_at = NOW()
       WHERE id = $1 AND owner_user_id = $2 AND status IN ('draft', 'sent', 'in_progress')
       RETURNING id`,
      [requestId, userId],
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This request cannot be voided.' });
    }
    await client.query("UPDATE signature_recipients SET status = 'canceled' WHERE request_id = $1 AND status != 'completed'", [requestId]);
    await audit(client, { requestId, eventType: 'voided', req });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('sign-requests void error:', error.message);
    res.status(500).json({ error: 'Failed to void signature request.' });
  } finally {
    client.release();
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  if (!Number.isInteger(requestId) || requestId < 1) return res.status(400).json({ error: 'Invalid request ID.' });
  try {
    const userId = await findOrCreateUser(req.user);
    const result = await pool.query('DELETE FROM signature_requests WHERE id = $1 AND owner_user_id = $2', [requestId, userId]);
    if (!result.rowCount) return res.status(404).json({ error: 'Signature request not found.' });
    res.json({ ok: true });
  } catch (error) {
    console.error('sign-requests delete error:', error.message);
    res.status(500).json({ error: 'Failed to delete signature request.' });
  }
});

router.get('/public/:token', async (req, res) => {
  if (!TOKEN_RE.test(req.params.token)) return res.status(404).json({ error: 'Signature link not found.' });
  try {
    const recipientResult = await pool.query(
      `SELECT sr.id AS recipient_id, sr.name, sr.email, sr.status AS recipient_status,
              r.id AS request_id, r.owner_user_id, r.title, r.document_name, r.document_mime, r.document_data, r.status AS request_status, r.expires_at
       FROM signature_recipients sr
       JOIN signature_requests r ON r.id = sr.request_id
       WHERE sr.token = $1
       LIMIT 1`,
      [req.params.token],
    );
    if (!recipientResult.rows.length) return res.status(404).json({ error: 'Signature link not found.' });
    const row = recipientResult.rows[0];
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'Signature link expired.' });
    if (row.request_status === 'draft' || row.recipient_status === 'draft') return res.status(404).json({ error: 'Signature link not found.' });
    if (['declined', 'expired', 'voided'].includes(row.request_status)) return res.status(410).json({ error: 'This signature request is no longer active.' });
    if (row.recipient_status === 'waiting') return res.status(423).json({ error: 'This request is waiting for a previous signer.' });
    if (row.recipient_status === 'declined') return res.status(410).json({ error: 'This signature request was declined.' });
    await pool.query('UPDATE signature_recipients SET viewed_at = COALESCE(viewed_at, NOW()) WHERE id = $1', [row.recipient_id]);
    await audit(pool, { requestId: row.request_id, recipientId: row.recipient_id, eventType: 'viewed', req });
    const fields = await pool.query(
      `SELECT id, field_type, page_number, x, y, width, height, required, label, value_text
       FROM signature_fields
       WHERE recipient_id = $1
       ORDER BY page_number, id`,
      [row.recipient_id],
    );
    res.json({
      request: { id: row.request_id, title: row.title, documentName: row.document_name, status: row.request_status },
      brand: await brandFor(row.owner_user_id).catch(() => null),
      recipient: { name: row.name, email: row.email, status: row.recipient_status },
      fields: fields.rows,
      documentBase64: `data:${row.document_mime};base64,${Buffer.from(row.document_data).toString('base64')}`,
    });
  } catch (err) {
    console.error('sign-requests public GET error:', err.message);
    res.status(500).json({ error: 'Failed to load signature request.' });
  }
});

router.get('/public/:token/final-pdf', async (req, res) => {
  if (!TOKEN_RE.test(req.params.token)) return res.status(404).json({ error: 'Signature link not found.' });
  try {
    const { rows } = await pool.query(
      `SELECT sr.id AS recipient_id, r.id AS request_id, r.status
       FROM signature_recipients sr JOIN signature_requests r ON r.id = sr.request_id WHERE sr.token = $1`,
      [req.params.token],
    );
    if (!rows.length) return res.status(404).json({ error: 'Signature link not found.' });
    if (rows[0].status !== 'completed') return res.status(409).json({ error: 'The completed document is available once everyone has signed.' });
    await sendFinalPdf(res, rows[0].request_id, req, 'signer_copy_downloaded', rows[0].recipient_id);
  } catch (err) {
    console.error('sign-requests public final PDF error:', err.message);
    res.status(500).json({ error: 'Failed to generate the completed document.' });
  }
});

router.post('/public/:token/complete', async (req, res) => {
  if (!TOKEN_RE.test(req.params.token)) return res.status(404).json({ error: 'Signature link not found.' });
  if (req.body?.consent !== true) return res.status(400).json({ error: 'Electronic-signature consent is required.' });
  const values = Array.isArray(req.body?.values) ? req.body.values : [];
  if (values.length > 200) return res.status(400).json({ error: 'Too many field values.' });
  const client = await pool.connect();
  let nextSigner = null;
  try {
    await client.query('BEGIN');
    const recipientResult = await client.query(
      `SELECT sr.id, sr.request_id, sr.status AS recipient_status,
              r.status AS request_status, r.expires_at, r.document_hash
       FROM signature_recipients sr
       JOIN signature_requests r ON r.id = sr.request_id
       WHERE sr.token = $1
       LIMIT 1
       FOR UPDATE OF sr, r`,
      [req.params.token],
    );
    if (!recipientResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Signature link not found.' });
    }
    const recipient = recipientResult.rows[0];
    if (recipient.expires_at && new Date(recipient.expires_at).getTime() < Date.now()) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Signature link expired.' });
    }
    if (!['sent', 'in_progress'].includes(recipient.request_status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This signature request is not active.' });
    }
    if (recipient.recipient_status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This signer is not currently eligible to complete the request.' });
    }

    const existing = await client.query('SELECT id, required, field_type FROM signature_fields WHERE recipient_id = $1', [recipient.id]);
    const existingIds = new Set(existing.rows.map(row => Number(row.id)));
    const fieldTypes = new Map(existing.rows.map(row => [Number(row.id), row.field_type]));
    const provided = new Map();
    for (const value of values) {
      const fieldId = Number(value?.fieldId);
      if (!fieldTypes.has(fieldId)) continue;
      const normalized = normalizeFieldValue(fieldTypes.get(fieldId), value.value);
      if (normalized === null) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A signature image could not be read. Please draw it again.' });
      }
      provided.set(fieldId, normalized);
    }
    for (const row of existing.rows) {
      if (row.required && !provided.get(Number(row.id))) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Complete all required fields.' });
      }
    }
    const acceptedValues = [...provided.entries()].filter(([fieldId]) => existingIds.has(fieldId));
    for (const [fieldId, value] of acceptedValues) {
      await client.query('UPDATE signature_fields SET value_text = $1, completed_at = NOW() WHERE id = $2 AND recipient_id = $3', [value, fieldId, recipient.id]);
    }
    const completionHash = createHash('sha256').update(JSON.stringify({
      documentHash: recipient.document_hash,
      recipientId: recipient.id,
      values: acceptedValues.sort((a, b) => a[0] - b[0]),
    })).digest('hex');
    await client.query("UPDATE signature_recipients SET status = 'completed', completed_at = NOW(), consented_at = NOW(), completion_hash = $1 WHERE id = $2", [completionHash, recipient.id]);
    await audit(client, { requestId: recipient.request_id, recipientId: recipient.id, eventType: 'completed', detail: `Electronic-signature consent recorded; SHA-256 ${completionHash}`, req });

    const next = await client.query(
      `SELECT sr.id, sr.name, sr.email, sr.token, r.title, r.document_name, r.message, u.email AS owner_email, u.id AS owner_id
       FROM signature_recipients sr
       JOIN signature_requests r ON r.id = sr.request_id
       JOIN users u ON u.id = r.owner_user_id
       WHERE sr.request_id = $1 AND sr.status = 'waiting'
       ORDER BY sr.role_order, sr.id
       LIMIT 1`,
      [recipient.request_id],
    );
    if (next.rows.length) {
      nextSigner = { ...next.rows[0], url: signingUrl(next.rows[0].token) };
      await client.query("UPDATE signature_recipients SET status = 'pending' WHERE id = $1 AND status = 'waiting'", [nextSigner.id]);
      await client.query("UPDATE signature_requests SET status = 'in_progress', updated_at = NOW() WHERE id = $1", [recipient.request_id]);
      await audit(client, { requestId: recipient.request_id, recipientId: nextSigner.id, eventType: 'advanced', detail: 'Sequential signer activated', req });
    } else {
      await client.query("UPDATE signature_requests SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1", [recipient.request_id]);
      await audit(client, { requestId: recipient.request_id, eventType: 'request_completed', detail: 'All signers completed', req });
    }
    await client.query('COMMIT');
    if (!nextSigner) notifyCompleted(recipient.request_id).catch(err => console.error('completion email error:', err.message));

    if (nextSigner) {
      try {
        await sendEmail({
          to: nextSigner.email,
          subject: `Signature requested: ${nextSigner.title}`,
          html: signerEmailHtml({ signer: nextSigner, title: nextSigner.title, documentName: nextSigner.document_name, message: nextSigner.message, ownerEmail: nextSigner.owner_email, brand: await brandFor(nextSigner.owner_id).catch(() => null) }),
        });
        await recordNotification(pool, { requestId: recipient.request_id, recipientId: nextSigner.id, type: 'signature_request_advanced', status: 'sent' });
      } catch (error) {
        await recordNotification(pool, { requestId: recipient.request_id, recipientId: nextSigner.id, type: 'signature_request_advanced', status: 'failed', error: error.message });
      }
    }
    res.json({ ok: true, completionHash });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('sign-requests public complete error:', err.message);
    res.status(500).json({ error: 'Failed to complete signature request.' });
  } finally {
    client.release();
  }
});

router.post('/public/:token/decline', async (req, res) => {
  if (!TOKEN_RE.test(req.params.token)) return res.status(404).json({ error: 'Signature link not found.' });
  const reason = String(req.body?.reason || '').trim().slice(0, 1000) || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const recipientResult = await client.query(
      `SELECT sr.id, sr.name, sr.request_id, sr.status AS recipient_status,
              r.status AS request_status, r.expires_at
       FROM signature_recipients sr
       JOIN signature_requests r ON r.id = sr.request_id
       WHERE sr.token = $1
       LIMIT 1
       FOR UPDATE OF sr, r`,
      [req.params.token],
    );
    if (!recipientResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Signature link not found.' });
    }
    const recipient = recipientResult.rows[0];
    if (recipient.expires_at && new Date(recipient.expires_at).getTime() < Date.now()) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Signature link expired.' });
    }
    if (!['sent', 'in_progress'].includes(recipient.request_status) || recipient.recipient_status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This signer cannot decline the request in its current state.' });
    }
    await client.query("UPDATE signature_recipients SET status = 'declined', declined_at = NOW(), decline_reason = $1 WHERE id = $2", [reason, recipient.id]);
    await client.query("UPDATE signature_recipients SET status = 'canceled' WHERE request_id = $1 AND status IN ('pending', 'waiting')", [recipient.request_id]);
    await client.query("UPDATE signature_requests SET status = 'declined', updated_at = NOW() WHERE id = $1", [recipient.request_id]);
    await audit(client, { requestId: recipient.request_id, recipientId: recipient.id, eventType: 'declined', detail: reason, req });
    await client.query('COMMIT');
    notifyDeclined(recipient.request_id, recipient.name, reason).catch(err => console.error('decline email error:', err.message));
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('sign-requests public decline error:', err.message);
    res.status(500).json({ error: 'Failed to decline signature request.' });
  } finally {
    client.release();
  }
});

export default router;
