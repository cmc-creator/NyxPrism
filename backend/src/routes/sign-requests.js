import { Router } from 'express';
import { randomBytes } from 'crypto';
import pool from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELD_TYPES = new Set(['signature', 'initials', 'name', 'date', 'text', 'checkbox']);
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

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
    `INSERT INTO users (firebase_uid, email, plan, subscription_status, trial_start)
     VALUES ($1, $2, 'trial', 'trialing', NOW())
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
      `SELECT id, title, document_name, status, created_at, sent_at, completed_at
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

router.post('/', requireAuth, async (req, res) => {
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
    const requestResult = await client.query(
      `INSERT INTO signature_requests (owner_user_id, title, document_name, document_mime, document_size, document_data, message, status)
       VALUES ($1, $2, $3, 'application/pdf', $4, $5, $6, $7)
       RETURNING id, title, document_name, status, created_at`,
      [userId, title, documentName, documentBuffer.length, documentBuffer, message, sendNow ? 'sent' : 'draft'],
    );
    request = requestResult.rows[0];

    const recipientIds = new Map();
    for (const recipient of recipients) {
      const token = randomBytes(32).toString('hex');
      const inserted = await client.query(
        `INSERT INTO signature_recipients (request_id, name, email, role_order, token, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING id, email`,
        [request.id, recipient.name, recipient.email, recipient.roleOrder, token],
      );
      recipientIds.set(inserted.rows[0].email, inserted.rows[0].id);
      signers.push({ ...recipient, token, url: `${process.env.FRONTEND_URL || 'https://nyxprism.com'}/sign-request.html?token=${token}` });
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
      await Promise.all(signers.map(signer => sendEmail({
        to: signer.email,
        subject: `Signature requested: ${title}`,
        html: `<p>Hello ${escapeHtml(signer.name)},</p><p>${escapeHtml(req.user.email || 'NyxPrism')} requested your signature on <strong>${escapeHtml(documentName)}</strong>.</p>${message ? `<p style="white-space:pre-wrap;">${escapeHtml(message)}</p>` : ''}<p><a href="${signer.url}">Review and sign the document</a></p><p>This secure link is unique to you.</p>`,
      })));
    } catch (err) {
      emailWarning = 'Draft saved, but email delivery failed. Check BREVO_API_KEY.';
      console.error('sign-requests email error:', err.message);
    }
  }

  res.status(201).json({ request, signers: signers.map(({ name, email, url }) => ({ name, email, url })), warning: emailWarning });
});

router.get('/public/:token', async (req, res) => {
  try {
    const recipientResult = await pool.query(
      `SELECT sr.id AS recipient_id, sr.name, sr.email, sr.status AS recipient_status,
              r.id AS request_id, r.title, r.document_name, r.document_mime, r.document_data, r.status AS request_status
       FROM signature_recipients sr
       JOIN signature_requests r ON r.id = sr.request_id
       WHERE sr.token = $1
       LIMIT 1`,
      [req.params.token],
    );
    if (!recipientResult.rows.length) return res.status(404).json({ error: 'Signature link not found.' });
    const row = recipientResult.rows[0];
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
  const values = Array.isArray(req.body?.values) ? req.body.values : [];
  try {
    const recipientResult = await pool.query('SELECT id, request_id FROM signature_recipients WHERE token = $1 LIMIT 1', [req.params.token]);
    if (!recipientResult.rows.length) return res.status(404).json({ error: 'Signature link not found.' });
    const recipient = recipientResult.rows[0];

    const existing = await pool.query('SELECT id, required FROM signature_fields WHERE recipient_id = $1', [recipient.id]);
    const existingIds = new Set(existing.rows.map(row => Number(row.id)));
    const provided = new Map(values.map(value => [Number(value.fieldId), String(value.value || '').trim().slice(0, 1000)]));
    for (const row of existing.rows) {
      if (row.required && !provided.get(Number(row.id))) return res.status(400).json({ error: 'Complete all required fields.' });
    }
    for (const [fieldId, value] of provided.entries()) {
      if (!existingIds.has(fieldId)) continue;
      await pool.query('UPDATE signature_fields SET value_text = $1, completed_at = NOW() WHERE id = $2 AND recipient_id = $3', [value, fieldId, recipient.id]);
    }
    await pool.query('UPDATE signature_recipients SET status = $1, completed_at = NOW() WHERE id = $2', ['completed', recipient.id]);

    const remaining = await pool.query('SELECT COUNT(*) AS count FROM signature_recipients WHERE request_id = $1 AND status != $2', [recipient.request_id, 'completed']);
    if (Number(remaining.rows[0].count) === 0) {
      await pool.query('UPDATE signature_requests SET status = $1, completed_at = NOW(), updated_at = NOW() WHERE id = $2', ['completed', recipient.request_id]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('sign-requests public complete error:', err.message);
    res.status(500).json({ error: 'Failed to complete signature request.' });
  }
});

export default router;
