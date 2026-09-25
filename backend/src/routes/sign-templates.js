import { Router } from 'express';
import pool from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const FIELD_TYPES = new Set(['signature', 'initials', 'name', 'date', 'text', 'checkbox']);
const clamp = (n, lo, hi, dflt) => { const v = Number(n); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt; };

async function userIdFor(user) {
  const { rows } = await pool.query('SELECT id FROM users WHERE firebase_uid = $1 OR email = $2 LIMIT 1', [user.uid, user.email]);
  return rows[0]?.id || null;
}

// GET /api/sign-templates
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = await userIdFor(req.user);
    if (!userId) return res.json({ templates: [] });
    const { rows } = await pool.query(
      'SELECT id, name, signer_count, page_count, fields, created_at FROM signature_templates WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [userId],
    );
    res.json({ templates: rows });
  } catch (err) {
    console.error('sign-templates list error:', err.message);
    res.status(500).json({ error: 'Failed to load templates.' });
  }
});

// POST /api/sign-templates  { name, pageCount, fields: [{ type, signer (0-based), pageNumber, x, y, width, height, label, required }] }
router.post('/', requireAuth, async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120);
  const fields = Array.isArray(req.body?.fields) ? req.body.fields : [];
  if (!name) return res.status(400).json({ error: 'Give the template a name.' });
  if (!fields.length || fields.length > 200) return res.status(400).json({ error: 'A template needs 1–200 fields.' });
  const clean = [];
  for (const f of fields) {
    const type = String(f?.type || '').toLowerCase();
    if (!FIELD_TYPES.has(type)) return res.status(400).json({ error: 'Invalid field type.' });
    clean.push({
      type, signer: Math.floor(clamp(f.signer, 0, 9, 0)), pageNumber: Math.floor(clamp(f.pageNumber, 1, 10000, 1)),
      x: clamp(f.x, 0, 1, 0), y: clamp(f.y, 0, 1, 0), width: clamp(f.width, 0.02, 1, 0.22), height: clamp(f.height, 0.02, 1, 0.06),
      label: String(f.label || type).slice(0, 80), required: f.required !== false,
    });
  }
  const signerCount = Math.max(...clean.map(f => f.signer)) + 1;
  try {
    const userId = await userIdFor(req.user);
    if (!userId) return res.status(403).json({ error: 'Create your NyxPrism account first.' });
    const count = await pool.query('SELECT COUNT(*) AS n FROM signature_templates WHERE owner_user_id = $1', [userId]);
    if (Number(count.rows[0].n) >= 100) return res.status(409).json({ error: 'You can keep up to 100 templates. Delete one first.' });
    const { rows } = await pool.query(
      `INSERT INTO signature_templates (owner_user_id, name, signer_count, page_count, fields)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id, name, signer_count, page_count, fields, created_at`,
      [userId, name, signerCount, req.body?.pageCount ? Math.floor(clamp(req.body.pageCount, 1, 10000, 1)) : null, JSON.stringify(clean)],
    );
    res.status(201).json({ template: rows[0] });
  } catch (err) {
    console.error('sign-templates create error:', err.message);
    res.status(500).json({ error: 'Failed to save the template.' });
  }
});

// DELETE /api/sign-templates/:id
router.delete('/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid template.' });
  try {
    const userId = await userIdFor(req.user);
    const result = await pool.query('DELETE FROM signature_templates WHERE id = $1 AND owner_user_id = $2', [id, userId]);
    if (!result.rowCount) return res.status(404).json({ error: 'Template not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('sign-templates delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete the template.' });
  }
});

export default router;
