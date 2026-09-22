import { Router } from 'express';
import { randomBytes } from 'crypto';
import pool from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELD_TYPES = new Set(['signature', 'initials', 'name', 'date', 'text', 'checkbox']);

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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = await findOrCreateUser(req.user);
    const requestResult = await client.query(
      `INSERT INTO signature_requests (owner_user_id, title, document_name, message, status)
       VALUES ($1, $2, $3, $4, 'draft')
       RETURNING id, title, document_name, status, created_at`,
      [userId, title, documentName, message],
    );
    const request = requestResult.rows[0];

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

    await client.query('COMMIT');
    res.status(201).json({ request });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sign-requests POST error:', err.message);
    res.status(500).json({ error: 'Failed to create signature request.' });
  } finally {
    client.release();
  }
});

export default router;
