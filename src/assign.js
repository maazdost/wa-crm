const { pool } = require('./db');

/**
 * Sticky assignment. Picks the best agent for a conversation inside a transaction
 * guarded by an advisory lock so two simultaneous chats never pick the same slot.
 * Preference: matching team -> any team. Lowest active chat count first, then
 * longest-since-last-assigned (fair round-robin). Respects max_active_chats.
 */
async function assignConversation(conversationId, team) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7001)');
    const pick = async (teamFilter) => (await client.query(
      `SELECT u.id,
              (SELECT COUNT(*) FROM conversations c WHERE c.assigned_to=u.id AND c.status='open') AS active
         FROM users u
        WHERE u.role='agent' AND u.is_active
          AND ($1::text IS NULL OR u.team=$1)
        ORDER BY (SELECT COUNT(*) FROM conversations c WHERE c.assigned_to=u.id AND c.status='open') >= u.max_active_chats,
                 u.is_online DESC,
                 active ASC,
                 u.last_assigned_at ASC NULLS FIRST
        LIMIT 1`, [teamFilter])).rows[0];
    let agent = team ? await pick(team) : null;
    if (!agent) agent = await pick(null);
    if (!agent) { await client.query('ROLLBACK'); return null; }
    await client.query('UPDATE users SET last_assigned_at=now() WHERE id=$1', [agent.id]);
    const { rows } = await client.query(
      `UPDATE conversations SET assigned_to=$1, status='open' WHERE id=$2 RETURNING *`, [agent.id, conversationId]);
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

module.exports = { assignConversation };
