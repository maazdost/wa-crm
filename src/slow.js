// Slow-reply alert: when a client has been given to an agent and the agent has not written for a few minutes,
// the managers and admins are told, and the chat moves to the next free agent of the same department. It keeps moving
// every few minutes, through each agent of the department in turn, until someone replies.
// Switched on per company under Settings > Chat assignment (assign.slow_on, assign.slow_min). Off by default.
// Only runs in working hours (assign.slow_hours, slow_start, slow_end, slow_tz; default 10:00 to 22:00 Pakistan time).
// Runs every minute (SLOW_TICK_MS) for every company that has it switched on.
const { query } = require('./db');
const tenant = require('./tenant');
const settings = require('./settings');
const { assignConversation } = require('./assign');

const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const localNow = (tz) => { const d = new Date(new Date().toLocaleString('en-US', { timeZone: tz || 'Asia/Karachi' })); return { day: d.getDay(), mins: d.getHours() * 60 + d.getMinutes(), secs: d.getSeconds() }; };
// When the slow-reply rule may act. With working hours on (Settings > Chat assignment, default 10:00 to 22:00 Pakistan time)
// it is off outside them: no alerts and no moves. The wait is counted from the start of the hours, so a chat that came in
// at night gets the full wait after opening time instead of moving the moment the hours start.
// Hours like 22:00 to 06:00 run past midnight; the same start and end time means all day.
// With working hours off it falls back to the away message hours (as before), if the away message is on.
function hours(cfg) {
  if (cfg.slow_hours === false) return null;
  const s = toMin(cfg.slow_start || '10:00'), e = toMin(cfg.slow_end || '22:00'), t = localNow(cfg.slow_tz);
  if (s === e) return { open: true, since: null };
  const open = s < e ? t.mins >= s && t.mins < e : t.mins >= s || t.mins < e;
  const since = ((t.mins - s + 1440) % 1440) * 60000 + t.secs * 1000; // how long ago today's hours started
  return { open, since: open ? new Date(Date.now() - since).toISOString() : null };
}
async function offHours() {
  const a = await settings.get('away'); if (!a.enabled) return false;
  const t = localNow(a.tz);
  return !(a.days.includes(t.day) && t.mins >= toMin(a.start) && t.mins < toMin(a.end));
}

/** Checks one company. Returns what it did: [{ conversation_id, from, to }] */
async function checkCompany() {
  const cfg = await settings.get('assign'); if (!cfg.slow_on) return [];
  const h = hours(cfg);
  if (h ? !h.open : await offHours()) return [];
  const min = Math.min(120, Math.max(2, Number(cfg.slow_min) || 10)), cid = tenant.cid();
  // Open chats with an agent, where the client wrote, and no person has written since the chat was given to this agent.
  const late = (await query(`SELECT c.*, COALESCE(ct.name, ct.profile_name, '+' || ct.wa_id) AS who, u.name AS agent
      FROM conversations c JOIN contacts ct ON ct.id=c.contact_id JOIN users u ON u.id=c.assigned_to
     WHERE c.company_id=$1 AND c.status='open' AND c.assigned_at IS NOT NULL AND c.last_customer_message_at IS NOT NULL
       AND GREATEST(c.assigned_at, $4::timestamptz) < now() - ($2 || ' minutes')::interval -- the wait starts at opening time at the earliest
       AND c.assigned_at > GREATEST(now() - interval '1 day', $3::timestamptz) -- only chats given out since it was switched on, and not old ones
       AND (c.slow_alerted_at IS NULL OR c.slow_alerted_at < c.assigned_at)
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.sender_type='agent' AND m.created_at >= c.assigned_at)
     ORDER BY c.assigned_at LIMIT 20`, [cid, String(min), cfg.slow_since || new Date().toISOString(), h && h.since])).rows;
  const done = [], rt = require('./realtime'), push = require('./push');
  for (const c of late) {
    // Marked first, so a slow check or an error never alerts twice for the same wait.
    const claimed = (await query(`UPDATE conversations SET slow_alerted_at=now() WHERE id=$1 AND (slow_alerted_at IS NULL OR slow_alerted_at < assigned_at) RETURNING id`, [c.id])).rows[0];
    if (!claimed) continue;
    let moved = null;
    if (!c.locked_to) { // a client kept with one agent is never moved: managers are only alerted
      // Who already had this client without replying (since the last reply by a person): the next one is someone new;
      // when everyone in the department has had a turn, it goes round again (never back to the same person in a row).
      const tried = (await query(`SELECT DISTINCT agent_id FROM slow_replies WHERE conversation_id=$1 AND created_at > COALESCE(
          (SELECT MAX(created_at) FROM messages WHERE conversation_id=$1 AND sender_type='agent'), '-infinity')`, [c.id])).rows.map(r => r.agent_id);
      // It stays in the client's department; only a department with nobody in rotation (e.g. General) borrows from the others.
      const own = c.team ? (await query(`SELECT COUNT(*)::int AS n FROM users WHERE company_id=$1 AND is_active AND in_rotation AND (team=$2 OR extra_teams ? $2)`, [cid, c.team])).rows[0].n : 0;
      const go = (ex) => assignConversation(c.id, c.team, { exclude: ex, teamOnly: own > 0 }).catch(e => { console.error('slow reply move', e.message); return null; });
      moved = await go([c.assigned_to, ...tried]);
      if (!moved) moved = await go([c.assigned_to]);
      if (moved && moved.assigned_to !== c.assigned_to) {
        await query('UPDATE conversations SET slow_moved=TRUE, slow_alerted_at=NULL WHERE id=$1', [c.id]); // the new agent's wait is watched too
        const to = (await query('SELECT name FROM users WHERE id=$1', [moved.assigned_to])).rows[0];
        moved.agent = to && to.name;
        push.notifyUser(moved.assigned_to, 'New client assigned', `${c.who}: ${c.agent} did not reply in ${min} min`, { conversationId: c.id }, 'assigned');
        rt.toUser(moved.assigned_to, 'conversation:assigned', { conversationId: c.id, name: c.who });
      } else moved = null;
    }
    await query('INSERT INTO slow_replies(company_id, conversation_id, agent_id, moved_to, minutes) VALUES($1,$2,$3,$4,$5)', [cid, c.id, c.assigned_to, moved ? moved.assigned_to : null, min]);
    const text = moved ? `${c.agent} did not reply to ${c.who} in ${min} min. Moved to ${moved.agent}.` : `${c.agent} has not replied to ${c.who} for ${min} min.`;
    push.notifyManagers(cid, 'Late reply', text, { conversationId: c.id }, 'message');
    rt.toConversation({ company_id: cid }, 'conversation:late', { conversationId: c.id, text });
    rt.toConversation(moved || c, 'conversation:updated', { conversationId: c.id });
    done.push({ conversation_id: c.id, from: c.assigned_to, to: moved ? moved.assigned_to : null });
  }
  return done;
}

async function run() {
  const cos = (await query(`SELECT company_id FROM settings WHERE key='assign' AND (value->>'slow_on')::boolean IS TRUE`)).rows;
  for (const { company_id } of cos) await tenant.run(company_id, () => checkCompany().catch(e => console.error('slow reply', e.message)));
}
let busy = false;
const start = () => setInterval(async () => { if (busy) return; busy = true; try { await run(); } catch (e) { console.error('slow reply', e.message); } finally { busy = false; } }, Number(process.env.SLOW_TICK_MS || 60000));
module.exports = { start, run, checkCompany, hours };
