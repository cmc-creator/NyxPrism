import { Router } from 'express';
import { randomBytes } from 'crypto';
import pool from '../db/index.js';
import { requireActivePlan, requireAuth } from '../middleware/auth.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_USER_DOCUMENT_BYTES = 100 * 1024 * 1024;
const DISTRIBUTION_DAYS = 30;
const TOKEN_RE = /^[a-f0-9]{64}$/;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function findOrCreateUser(user) {
  const existing = await pool.query('SELECT id FROM users WHERE firebase_uid = $1 OR email = $2 LIMIT 1', [user.uid, user.email]);
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

function normalizeDocument(body) {
  const raw = String(body?.documentBase64 || '').trim();
  if (!raw) throw new Error('PDF document is required.');
  const base64 = raw.includes(',') ? raw.split(',').pop() : raw;
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length || buffer.length > MAX_DOCUMENT_BYTES) throw new Error('PDF must be 8 MB or smaller.');
  if (buffer.slice(0, 4).toString() !== '%PDF') throw new Error('Document must be a PDF.');
  return buffer;
}

function normalizeRecipients(recipients) {
  if (!Array.isArray(recipients) || recipients.length < 1) throw new Error('At least one recipient is required.');
  if (recipients.length > 250) throw new Error('Maximum 250 recipients per distribution batch.');
  return recipients.map((recipient) => {
    const name = String(recipient.name || '').trim().slice(0, 120);
    const email = String(recipient.email || '').trim().toLowerCase().slice(0, 254);
    if (!name || !EMAIL_RE.test(email)) throw new Error('Each recipient needs a valid name and email.');
    return { name, email };
  });
}

async function sendEmail({ to, subject, html }) {
  if (!process.env.BREVO_API_KEY) throw new Error('BREVO_API_KEY is not configured.');
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: { name: 'NyxPrism Documents', email: 'noreply@nyxprism.com' }, to: [{ email: to }], subject, htmlContent: html }),
  });
  if (!res.ok) throw new Error(`Brevo error ${res.status}`);
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = await findOrCreateUser(req.user);
    const result = await pool.query(
      `SELECT b.id, b.title, b.document_name, b.status, b.created_at, b.sent_at, b.expires_at,
              COUNT(r.id)::int AS recipient_count,
              COUNT(*) FILTER (WHERE r.status = 'opened')::int AS opened_count,
              COUNT(*) FILTER (WHERE r.status = 'failed')::int AS failed_count
       FROM distribution_batches b
       LEFT JOIN distribution_recipients r ON r.batch_id = b.id
       WHERE b.owner_user_id = $1
       GROUP BY b.id
       ORDER BY b.created_at DESC
       LIMIT 50`,
      [userId],
    );
    res.json({ batches: result.rows });
  } catch (err) {
    console.error('distributions GET error:', err.message);
    res.status(500).json({ error: 'Failed to load distributions.' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  const batchId = parseInt(req.params.id, 10);
  if (!Number.isInteger(batchId) || batchId < 1) return res.status(400).json({ error: 'Invalid batch ID.' });
  try {
    const userId = await findOrCreateUser(req.user);
    const batch = await pool.query('SELECT id, title, document_name, status, created_at, sent_at, expires_at FROM distribution_batches WHERE id = $1 AND owner_user_id = $2', [batchId, userId]);
    if (!batch.rows.length) return res.status(404).json({ error: 'Distribution batch not found.' });
    const recipients = await pool.query('SELECT id, name, email, status, sent_at, opened_at, failed_at, error FROM distribution_recipients WHERE batch_id = $1 ORDER BY id', [batchId]);
    res.json({ batch: batch.rows[0], recipients: recipients.rows });
  } catch (err) {
    console.error('distributions detail error:', err.message);
    res.status(500).json({ error: 'Failed to load distribution batch.' });
  }
});

router.post('/', requireAuth, requireActivePlan, async (req, res) => {
  let recipients;
  let documentBuffer;
  try {
    recipients = normalizeRecipients(req.body?.recipients);
    documentBuffer = normalizeDocument(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const title = String(req.body?.title || 'Document distribution').trim().slice(0, 160);
  const documentName = String(req.body?.documentName || 'document.pdf').trim().slice(0, 240);
  const sendNow = req.body?.sendNow === true;
  const client = await pool.connect();
  let batch;
  let rows = [];
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
    const batchResult = await client.query(
      `INSERT INTO distribution_batches (owner_user_id, title, document_name, document_mime, document_size, document_data, status, sent_at, expires_at)
       VALUES ($1, $2, $3, 'application/pdf', $4, $5, $6, $7, $8)
       RETURNING id, title, document_name, status, created_at, sent_at, expires_at`,
      [userId, title, documentName, documentBuffer.length, documentBuffer, sendNow ? 'sent' : 'draft', sendNow ? new Date() : null, new Date(Date.now() + DISTRIBUTION_DAYS * 86400000)],
    );
    batch = batchResult.rows[0];
    for (const recipient of recipients) {
      const token = randomBytes(32).toString('hex');
      const inserted = await client.query(
        `INSERT INTO distribution_recipients (batch_id, name, email, token, status)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, email, token, status`,
        [batch.id, recipient.name, recipient.email, token, sendNow ? 'queued' : 'draft'],
      );
      rows.push(inserted.rows[0]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('distributions POST error:', err.message);
    return res.status(500).json({ error: 'Failed to create distribution batch.' });
  } finally {
    client.release();
  }

  if (sendNow) {
    await Promise.all(rows.map(async row => {
      const url = `${process.env.FRONTEND_URL || 'https://nyxprism.com'}/distribution.html?token=${row.token}`;
      try {
        await sendEmail({ to: row.email, subject: `Document shared: ${title}`, html: `<p>Hello ${escapeHtml(row.name)},</p><p>${escapeHtml(req.user.email || 'NyxPrism')} shared <strong>${escapeHtml(documentName)}</strong> with you.</p><p><a href="${url}">Open document</a></p>` });
        await pool.query('UPDATE distribution_recipients SET status = $1, sent_at = NOW() WHERE id = $2', ['sent', row.id]);
      } catch (err) {
        await pool.query('UPDATE distribution_recipients SET status = $1, failed_at = NOW(), error = $2 WHERE id = $3', ['failed', err.message, row.id]);
      }
    }));
  }

  res.status(201).json({
    batch,
    recipients: rows.map(row => ({ name: row.name, email: row.email, ...(sendNow ? { url: `${process.env.FRONTEND_URL || 'https://nyxprism.com'}/distribution.html?token=${row.token}` } : {}) })),
  });
});

router.post('/:id/send', requireAuth, requireActivePlan, async (req, res) => {
  const batchId = parseInt(req.params.id, 10);
  if (!Number.isInteger(batchId) || batchId < 1) return res.status(400).json({ error: 'Invalid batch ID.' });
  const client = await pool.connect();
  let batch;
  let recipients;
  try {
    await client.query('BEGIN');
    const userId = await findOrCreateUser(req.user);
    const batchResult = await client.query(
      `SELECT id, title, document_name
       FROM distribution_batches
       WHERE id = $1 AND owner_user_id = $2 AND status = 'draft'
       FOR UPDATE`,
      [batchId, userId],
    );
    if (!batchResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Only an existing draft can be sent.' });
    }
    batch = batchResult.rows[0];
    const recipientResult = await client.query(
      `UPDATE distribution_recipients SET status = 'queued'
       WHERE batch_id = $1 AND status = 'draft'
       RETURNING id, name, email, token`,
      [batchId],
    );
    if (!recipientResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The draft has no recipients.' });
    }
    recipients = recipientResult.rows;
    await client.query("UPDATE distribution_batches SET status = 'sent', sent_at = NOW() WHERE id = $1", [batchId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('distribution send error:', error.message);
    return res.status(500).json({ error: 'Failed to send distribution.' });
  } finally {
    client.release();
  }

  let failed = 0;
  await Promise.all(recipients.map(async recipient => {
    const url = `${process.env.FRONTEND_URL || 'https://nyxprism.com'}/distribution.html?token=${recipient.token}`;
    try {
      await sendEmail({ to: recipient.email, subject: `Document shared: ${batch.title}`, html: `<p>Hello ${escapeHtml(recipient.name)},</p><p>${escapeHtml(req.user.email || 'NyxPrism')} shared <strong>${escapeHtml(batch.document_name)}</strong> with you.</p><p><a href="${url}">Open document</a></p>` });
      await pool.query("UPDATE distribution_recipients SET status = 'sent', sent_at = NOW() WHERE id = $1", [recipient.id]);
    } catch (error) {
      failed += 1;
      await pool.query("UPDATE distribution_recipients SET status = 'failed', failed_at = NOW(), error = $1 WHERE id = $2", [error.message, recipient.id]);
    }
  }));
  res.json({ ok: true, warning: failed ? `${failed} delivery attempt(s) failed.` : null });
});

router.post('/:id/revoke', requireAuth, async (req, res) => {
  const batchId = parseInt(req.params.id, 10);
  if (!Number.isInteger(batchId) || batchId < 1) return res.status(400).json({ error: 'Invalid batch ID.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = await findOrCreateUser(req.user);
    const result = await client.query(
      `UPDATE distribution_batches SET status = 'revoked'
       WHERE id = $1 AND owner_user_id = $2 AND status IN ('draft', 'sent')
       RETURNING id`,
      [batchId, userId],
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This distribution cannot be revoked.' });
    }
    await client.query("UPDATE distribution_recipients SET status = 'revoked' WHERE batch_id = $1", [batchId]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('distribution revoke error:', error.message);
    res.status(500).json({ error: 'Failed to revoke distribution.' });
  } finally {
    client.release();
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  const batchId = parseInt(req.params.id, 10);
  if (!Number.isInteger(batchId) || batchId < 1) return res.status(400).json({ error: 'Invalid batch ID.' });
  try {
    const userId = await findOrCreateUser(req.user);
    const result = await pool.query('DELETE FROM distribution_batches WHERE id = $1 AND owner_user_id = $2', [batchId, userId]);
    if (!result.rowCount) return res.status(404).json({ error: 'Distribution batch not found.' });
    res.json({ ok: true });
  } catch (error) {
    console.error('distribution delete error:', error.message);
    res.status(500).json({ error: 'Failed to delete distribution.' });
  }
});

router.get('/public/:token', async (req, res) => {
  if (!TOKEN_RE.test(req.params.token)) return res.status(404).json({ error: 'Document link not found.' });
  try {
    const result = await pool.query(
      `SELECT r.id, r.name, r.email, r.status, b.title, b.document_name, b.document_mime, b.document_data,
              b.status AS batch_status, b.expires_at
       FROM distribution_recipients r
       JOIN distribution_batches b ON b.id = r.batch_id
       WHERE r.token = $1
       LIMIT 1`,
      [req.params.token],
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Document link not found.' });
    const row = result.rows[0];
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    if (row.batch_status === 'draft' || row.status === 'draft') return res.status(404).json({ error: 'Document link not found.' });
    if (row.batch_status === 'revoked' || row.status === 'revoked') return res.status(410).json({ error: 'Document access was revoked.' });
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'Document link expired.' });
    await pool.query("UPDATE distribution_recipients SET status = CASE WHEN status = 'failed' THEN status ELSE 'opened' END, opened_at = COALESCE(opened_at, NOW()) WHERE id = $1", [row.id]);
    res.json({ title: row.title, documentName: row.document_name, recipient: { name: row.name, email: row.email }, documentBase64: `data:${row.document_mime};base64,${Buffer.from(row.document_data).toString('base64')}` });
  } catch (err) {
    console.error('distribution public error:', err.message);
    res.status(500).json({ error: 'Failed to load document.' });
  }
});

export default router;
