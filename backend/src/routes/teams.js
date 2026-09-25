import { Router } from 'express';
import { randomBytes } from 'crypto';
import pool from '../db/index.js';
import { requireAuth, requireVerifiedEmail } from '../middleware/auth.js';
import { activeTeamFor, managedTeamFor } from '../teams.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(['member', 'admin']);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function userRow(user) {
  const { rows } = await pool.query('SELECT id, email, first_name FROM users WHERE firebase_uid = $1 OR LOWER(email) = LOWER($2) LIMIT 1', [user.uid, user.email]);
  return rows[0] || null;
}

async function sendInviteEmail({ to, teamName, inviter, token }) {
  if (!process.env.BREVO_API_KEY) throw new Error('BREVO_API_KEY is not configured.');
  const url = `${(process.env.FRONTEND_URL || 'https://www.nyxprism.com').replace(/\/$/, '')}/dashboard.html?team_invite=${token}#account`;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'NyxPrism', email: 'noreply@nyxprism.com' },
      to: [{ email: to }],
      subject: `${inviter} invited you to ${teamName} on NyxPrism`,
      htmlContent: `<p>${escapeHtml(inviter)} invited you to join <strong>${escapeHtml(teamName)}</strong> on NyxPrism, with full Professional access.</p>
<p><a href="${url}">Accept the invitation</a></p>
<p>Sign in (or create a free account) with <strong>${escapeHtml(to)}</strong> to accept.</p>`,
    }),
  });
  if (!res.ok) throw new Error(`Brevo error ${res.status}`);
}

// GET /api/teams/mine - the team you manage, or the team you belong to.
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const me = await userRow(req.user);
    if (!me) return res.json({ team: null });
    const managed = await managedTeamFor(me.id);
    if (managed) {
      const [owner, members] = await Promise.all([
        pool.query('SELECT email, first_name, last_name FROM users WHERE id = $1', [managed.owner_user_id]),
        pool.query(
          `SELECT m.id, m.email, m.role, m.status, m.invited_at, m.joined_at, u.first_name, u.last_name
           FROM team_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.team_id = $1 ORDER BY m.status, m.invited_at`,
          [managed.id],
        ),
      ]);
      return res.json({
        team: { id: managed.id, name: managed.name, seats: managed.seats, used: members.rows.length },
        role: managed.role,
        owner: owner.rows[0],
        members: members.rows,
      });
    }
    const membership = await activeTeamFor(me.id);
    const anyMembership = membership || (await pool.query(
      `SELECT t.name, m.role FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = $1 AND m.status = 'active' LIMIT 1`, [me.id],
    )).rows[0];
    if (anyMembership) return res.json({ team: { name: anyMembership.name }, role: anyMembership.role, ownerEmail: membership?.ownerEmail || null, active: Boolean(membership) });
    res.json({ team: null });
  } catch (err) {
    console.error('teams mine error:', err.message);
    res.status(500).json({ error: 'Failed to load your team.' });
  }
});

// POST /api/teams/invite { email, role }
router.post('/invite', requireAuth, requireVerifiedEmail, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = ROLES.has(req.body?.role) ? req.body.role : 'member';
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  try {
    const me = await userRow(req.user);
    const team = me && await managedTeamFor(me.id);
    if (!team) return res.status(403).json({ error: 'Only a team owner or admin can invite people.' });
    if (role === 'admin' && team.role !== 'owner') return res.status(403).json({ error: 'Only the team owner can add admins.' });
    if (email === String(req.user.email).toLowerCase()) return res.status(400).json({ error: "You're already on this team." });
    const used = await pool.query('SELECT COUNT(*) AS n FROM team_members WHERE team_id = $1', [team.id]);
    if (Number(used.rows[0].n) >= team.seats) return res.status(409).json({ error: `All ${team.seats} seats are in use. Contact NyxPrism to add seats.` });
    const token = randomBytes(24).toString('hex');
    const inserted = await pool.query(
      `INSERT INTO team_members (team_id, email, role, status, invite_token) VALUES ($1, $2, $3, 'invited', $4)
       ON CONFLICT (team_id, email) DO NOTHING RETURNING id`,
      [team.id, email, role, token],
    );
    if (!inserted.rows.length) return res.status(409).json({ error: 'That person is already invited or on the team.' });
    let warning = null;
    try { await sendInviteEmail({ to: email, teamName: team.name, inviter: me.first_name || req.user.email, token }); }
    catch (err) { warning = 'Invitation saved, but the email could not be sent.'; console.error('team invite email error:', err.message); }
    res.status(201).json({ ok: true, warning });
  } catch (err) {
    console.error('teams invite error:', err.message);
    res.status(500).json({ error: 'Failed to send the invitation.' });
  }
});

// POST /api/teams/accept { token }
router.post('/accept', requireAuth, async (req, res) => {
  const token = String(req.body?.token || '');
  if (!/^[a-f0-9]{48}$/.test(token)) return res.status(400).json({ error: 'This invitation link is not valid.' });
  if (!req.user.email_verified) return res.status(403).json({ error: 'Verify your email address first, then open the invitation again.', code: 'email_unverified' });
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.email, m.status, t.name, t.owner_user_id FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.invite_token = $1`,
      [token],
    );
    const invite = rows[0];
    if (!invite || invite.status !== 'invited') return res.status(404).json({ error: 'This invitation has already been used or was cancelled.' });
    if (invite.email !== String(req.user.email).toLowerCase()) {
      return res.status(403).json({ error: `This invitation is for ${invite.email}. Sign in with that email to accept it.` });
    }
    const me = await userRow(req.user);
    if (!me) return res.status(403).json({ error: 'Finish creating your account, then open the invitation again.' });
    if (me.id === invite.owner_user_id) return res.status(400).json({ error: 'You already own this team.' });
    const existing = await pool.query("SELECT 1 FROM team_members WHERE user_id = $1 AND status = 'active'", [me.id]);
    if (existing.rows.length) return res.status(409).json({ error: 'You are already on a team. Leave it first to join this one.' });
    await pool.query("UPDATE team_members SET user_id = $1, status = 'active', joined_at = NOW(), invite_token = NULL WHERE id = $2", [me.id, invite.id]);
    res.json({ ok: true, team: invite.name });
  } catch (err) {
    console.error('teams accept error:', err.message);
    res.status(500).json({ error: 'Failed to accept the invitation.' });
  }
});

// DELETE /api/teams/members/:id - remove a member or cancel an invitation (owner/admin).
router.delete('/members/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid member.' });
  try {
    const me = await userRow(req.user);
    const team = me && await managedTeamFor(me.id);
    if (!team) return res.status(403).json({ error: 'Only a team owner or admin can remove people.' });
    const target = await pool.query('SELECT role, user_id FROM team_members WHERE id = $1 AND team_id = $2', [id, team.id]);
    if (!target.rows.length) return res.status(404).json({ error: 'Member not found.' });
    if (target.rows[0].role === 'admin' && team.role !== 'owner') return res.status(403).json({ error: 'Only the team owner can remove an admin.' });
    await pool.query('DELETE FROM team_members WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('teams remove error:', err.message);
    res.status(500).json({ error: 'Failed to remove the member.' });
  }
});

// POST /api/teams/leave
router.post('/leave', requireAuth, async (req, res) => {
  try {
    const me = await userRow(req.user);
    const result = me && await pool.query("DELETE FROM team_members WHERE user_id = $1 AND status = 'active'", [me.id]);
    if (!result?.rowCount) return res.status(404).json({ error: "You aren't on a team." });
    res.json({ ok: true });
  } catch (err) {
    console.error('teams leave error:', err.message);
    res.status(500).json({ error: 'Failed to leave the team.' });
  }
});

export default router;
