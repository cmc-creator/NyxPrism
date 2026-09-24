import { Router } from 'express';
import { createHash, randomBytes } from 'crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import pool from '../db/index.js';
import { requireActivePlan, requireAuth } from '../middleware/auth.js';

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
      sender: { name: 'NyxPrism Signatures', email: 'noreply@nyxprism.com' },
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

function signerEmailHtml({ signer, title, documentName, message, ownerEmail }) {
  return `<p>Hello ${escapeHtml(signer.name)},</p><p>${escapeHtml(ownerEmail || 'NyxPrism')} requested your signature on <strong>${escapeHtml(documentName)}</strong>.</p>${message ? `<p style="white-space:pre-wrap;">${escapeHtml(message)}</p>` : ''}<p><a href="${signer.url}">Review and sign the document</a></p><p>This secure link is unique to you.</p>`;
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
    const base = process.env.FRONTEND_URL || 'https://nyxprism.com';
    const request = requestResult.rows[0];
    res.json({
      request,
      recipients: recipients.rows.map(row => ({ ...row, ...(request.status !== 'draft' ? { url: `${base}/sign-request.html?token=${row.token}` } : {}) })),
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
    const requestResult = await pool.query(
      `SELECT id, title, document_name, document_data, status
       FROM signature_requests
       WHERE id = $1 AND owner_user_id = $2`,
      [requestId, userId],
    );
    if (!requestResult.rows.length) return res.status(404).json({ error: 'Signature request not found.' });
    const request = requestResult.rows[0];
    if (request.status !== 'completed') return res.status(409).json({ error: 'The final PDF is available after every signer completes.' });
    const fields = await pool.query(
      `SELECT field_type, page_number, x, y, width, height, value_text
       FROM signature_fields
       WHERE request_id = $1 AND value_text IS NOT NULL AND value_text != ''
       ORDER BY page_number, id`,
      [requestId],
    );
    if (!fields.rows.length) return res.status(400).json({ error: 'No completed fields to apply yet.' });

    const doc = await PDFDocument.load(Buffer.from(request.document_data), { ignoreEncryption: true });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    for (const field of fields.rows) {
      const page = pages[Number(field.page_number) - 1];
      if (!page) continue;
      const { width, height } = page.getSize();
      const boxHeight = Number(field.height) * height;
      const x = Number(field.x) * width + 4;
      const y = height - (Number(field.y) * height) - boxHeight + 4;
      const text = field.field_type === 'checkbox' ? 'X' : String(field.value_text || '');
      const fontSize = Math.max(9, Math.min(18, boxHeight * 0.52));
      page.drawText(text, { x, y, size: fontSize, font, color: rgb(0.08, 0.09, 0.12) });
    }
    const out = await doc.save();
    const finalHash = createHash('sha256').update(out).digest('hex');
    await audit(pool, { requestId, eventType: 'final_pdf_downloaded', detail: `SHA-256 ${finalHash}`, req });
    const fileName = String(request.document_name || 'signed-document.pdf').replace(/\.pdf$/i, '') + '-completed.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
    res.setHeader('X-Document-SHA256', finalHash);
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.send(Buffer.from(out));
  } catch (err) {
    console.error('sign-requests final PDF error:', err.message);
    res.status(500).json({ error: 'Failed to generate final signed PDF.' });
  }
});

router.post('/', requireAuth, requireActivePlan, async (req, res) => {
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
      const inserted = await client.query(
        `INSERT INTO signature_recipients (request_id, name, email, role_order, token, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email`,
        [request.id, recipient.name, recipient.email, recipient.roleOrder, token, recipientStatus],
      );
      recipientIds.set(inserted.rows[0].email, inserted.rows[0].id);
      signers.push({ ...recipient, id: inserted.rows[0].id, status: recipientStatus, token, url: `${process.env.FRONTEND_URL || 'https://nyxprism.com'}/sign-request.html?token=${token}` });
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
    try {
      await Promise.all(signers.filter(signer => signer.status === 'pending').map(async signer => {
        try {
          await sendEmail({ to: signer.email, subject: `Signature requested: ${title}`, html: signerEmailHtml({ signer, title, documentName, message, ownerEmail: req.user.email }) });
          await recordNotification(pool, { requestId: request.id, recipientId: signer.id, type: 'signature_request_sent', status: 'sent' });
        } catch (err) {
          await recordNotification(pool, { requestId: request.id, recipientId: signer.id, type: 'signature_request_sent', status: 'failed', error: err.message });
          throw err;
        }
      }));
    } catch (err) {
      emailWarning = 'Draft saved, but email delivery failed. Check BREVO_API_KEY.';
      console.error('sign-requests email error:', err.message);
    }
  }

  res.status(201).json({
    request,
    signers: signers.map(({ name, email, url }) => ({ name, email, ...(sendNow ? { url } : {}) })),
    warning: emailWarning,
  });
});

router.post('/:id/send', requireAuth, requireActivePlan, async (req, res) => {
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
      url: `${process.env.FRONTEND_URL || 'https://nyxprism.com'}/sign-request.html?token=${firstResult.rows[0].token}`,
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
    await sendEmail({ to: signer.email, subject: `Signature requested: ${signer.title}`, html: signerEmailHtml({ signer, title: signer.title, documentName: signer.document_name, message: signer.message, ownerEmail: req.user.email }) });
    await recordNotification(pool, { requestId, recipientId: signer.id, type: 'signature_request_sent', status: 'sent' });
  } catch (error) {
    warning = 'Request activated, but email delivery failed.';
    await recordNotification(pool, { requestId, recipientId: signer.id, type: 'signature_request_sent', status: 'failed', error: error.message });
  }
  res.json({ ok: true, warning });
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
              r.id AS request_id, r.title, r.document_name, r.document_mime, r.document_data, r.status AS request_status, r.expires_at
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
      recipient: { name: row.name, email: row.email, status: row.recipient_status },
      fields: fields.rows,
      documentBase64: `data:${row.document_mime};base64,${Buffer.from(row.document_data).toString('base64')}`,
    });
  } catch (err) {
    console.error('sign-requests public GET error:', err.message);
    res.status(500).json({ error: 'Failed to load signature request.' });
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

    const existing = await client.query('SELECT id, required FROM signature_fields WHERE recipient_id = $1', [recipient.id]);
    const existingIds = new Set(existing.rows.map(row => Number(row.id)));
    const provided = new Map(values.map(value => [Number(value.fieldId), String(value.value || '').trim().slice(0, 1000)]));
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
      `SELECT sr.id, sr.name, sr.email, sr.token, r.title, r.document_name, r.message, u.email AS owner_email
       FROM signature_recipients sr
       JOIN signature_requests r ON r.id = sr.request_id
       JOIN users u ON u.id = r.owner_user_id
       WHERE sr.request_id = $1 AND sr.status = 'waiting'
       ORDER BY sr.role_order, sr.id
       LIMIT 1`,
      [recipient.request_id],
    );
    if (next.rows.length) {
      nextSigner = { ...next.rows[0], url: `${process.env.FRONTEND_URL || 'https://nyxprism.com'}/sign-request.html?token=${next.rows[0].token}` };
      await client.query("UPDATE signature_recipients SET status = 'pending' WHERE id = $1 AND status = 'waiting'", [nextSigner.id]);
      await client.query("UPDATE signature_requests SET status = 'in_progress', updated_at = NOW() WHERE id = $1", [recipient.request_id]);
      await audit(client, { requestId: recipient.request_id, recipientId: nextSigner.id, eventType: 'advanced', detail: 'Sequential signer activated', req });
    } else {
      await client.query("UPDATE signature_requests SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1", [recipient.request_id]);
    }
    await client.query('COMMIT');

    if (nextSigner) {
      try {
        await sendEmail({
          to: nextSigner.email,
          subject: `Signature requested: ${nextSigner.title}`,
          html: signerEmailHtml({ signer: nextSigner, title: nextSigner.title, documentName: nextSigner.document_name, message: nextSigner.message, ownerEmail: nextSigner.owner_email }),
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
      `SELECT sr.id, sr.request_id, sr.status AS recipient_status,
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
