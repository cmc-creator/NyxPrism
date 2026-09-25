// Teams (Enterprise): an owner with Professional access shares it with invited members.
// Seats are granted from the owner portal; members get Professional through the team.
import pool from './db/index.js';
import { hasProfessionalAccess } from './access.js';

/** The active team membership for a user, if the team's owner currently has Professional access. */
export async function activeTeamFor(userId) {
  if (!userId) return null;
  const { rows } = await pool.query(
    `SELECT t.id AS team_id, t.name, m.role, o.id AS owner_id, o.email AS owner_email,
            o.plan AS owner_plan, o.subscription_status AS owner_status, o.trial_start AS owner_trial_start
     FROM team_members m
     JOIN teams t ON t.id = m.team_id
     JOIN users o ON o.id = t.owner_user_id
     WHERE m.user_id = $1 AND m.status = 'active'
     LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  const ownerAccount = { email: row.owner_email, plan: row.owner_plan, subscription_status: row.owner_status, trial_start: row.owner_trial_start };
  if (!hasProfessionalAccess(ownerAccount, row.owner_email)) return null;
  return { teamId: row.team_id, name: row.name, role: row.role, ownerEmail: row.owner_email };
}

/** Professional access from the user's own plan, or through an active team. */
export async function hasAccess(account, email) {
  if (hasProfessionalAccess(account, email)) return true;
  return Boolean(account?.id && await activeTeamFor(account.id));
}

/** The team a user owns or administers (for managing members). */
export async function managedTeamFor(userId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.seats, t.owner_user_id, 'owner' AS role FROM teams t WHERE t.owner_user_id = $1
     UNION ALL
     SELECT t.id, t.name, t.seats, t.owner_user_id, m.role FROM team_members m JOIN teams t ON t.id = m.team_id
     WHERE m.user_id = $1 AND m.status = 'active' AND m.role = 'admin'
     LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

/** User ids whose templates a user can use: their own, plus their team owner's and admins'. */
export async function templateOwnerIds(userId) {
  const ids = new Set([userId]);
  const { rows } = await pool.query(
    `SELECT t.owner_user_id AS id FROM team_members m JOIN teams t ON t.id = m.team_id
       WHERE m.user_id = $1 AND m.status = 'active'
     UNION
     SELECT m2.user_id AS id FROM team_members m JOIN team_members m2 ON m2.team_id = m.team_id
       WHERE m.user_id = $1 AND m.status = 'active' AND m2.status = 'active' AND m2.role = 'admin'
     UNION
     SELECT m.user_id AS id FROM teams t JOIN team_members m ON m.team_id = t.id
       WHERE t.owner_user_id = $1 AND m.status = 'active' AND m.role = 'admin'`,
    [userId],
  );
  rows.forEach(r => r.id && ids.add(r.id));
  return [...ids];
}
