const { pool } = require('./db');
const settings = require('./settings');

/**
 * Sticky assignment of a conversation to an agent, inside a transaction guarded by an advisory lock
 * so two simultaneous chats never pick the same slot. Order of preference: matching department, then any.
 * Only agents who are active, switched "in rotation" and below their chat limit are picked automatically
 * (online ones first). Two ways of choosing, set by the admin in Settings:
 *   least  - the agent with the fewest open chats
 *   turns  - agents take turns in a fixed order; each gets `batch` new chats (1 to 20) before the next one
 * Managers can always assign a chat by hand, which ignores all of this.
 */
async function assignConversation(conversationId, team) {
  const cfg = await settings.get('assign');
  const batch = Math.min(20, Math.max(1, Number(cfg.batch) || 1));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7001)');
    const candidates = async (teamFilter) => (await client.query(
      `SELECT u.id, u.is_online, u.max_active_chats,
              (SELECT COUNT(*) FROM conversations c WHERE c.assigned_to=u.id AND c.status='open')::int AS active
         FROM users u
        WHERE u.role='agent' AND u.is_active AND u.in_rotation AND ($1::text IS NULL OR u.team=$1)
        ORDER BY u.id`, [teamFilter])).rows;
    const pickLeast = (rows) => rows.slice().sort((a, b) =>
      (a.active >= a.max_active_chats) - (b.active >= b.max_active_chats) || (b.is_online - a.is_online) || (a.active - b.active) || (a.id - b.id))[0];
    const pickTurn = async (rows, key) => {
      const free = rows.filter(a => a.active < a.max_active_chats), live = free.filter(a => a.is_online), list = live.length ? live : free;
      if (!list.length) return null;
      const st = (await client.query('SELECT last_user_id, given FROM rr_state WHERE team=$1 FOR UPDATE', [key])).rows[0];
      let chosen, given;
      const cur = st && list.find(a => a.id === st.last_user_id);
      if (cur && st.given < batch) { chosen = cur; given = st.given + 1; }
      else { chosen = (st && list.find(a => a.id > st.last_user_id)) || list[0]; given = 1; }
      await client.query(`INSERT INTO rr_state(team,last_user_id,given) VALUES($1,$2,$3) ON CONFLICT (team) DO UPDATE SET last_user_id=EXCLUDED.last_user_id, given=EXCLUDED.given`, [key, chosen.id, given]);
      return chosen;
    };
    const pick = async (teamFilter) => {
      const rows = await candidates(teamFilter); if (!rows.length) return null;
      return cfg.mode === 'turns' ? pickTurn(rows, teamFilter || '*') : pickLeast(rows);
    };
    let agent = team ? await pick(team) : null;
    if (!agent) agent = await pick(null);
    if (!agent) { await client.query('ROLLBACK'); return null; }
    await client.query('UPDATE users SET last_assigned_at=now() WHERE id=$1', [agent.id]);
    const { rows } = await client.query(
      `UPDATE conversations SET assigned_to=$1, status='open', assigned_at=now() WHERE id=$2 RETURNING *`, [agent.id, conversationId]);
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

module.exports = { assignConversation };
