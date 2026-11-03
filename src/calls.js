// WhatsApp calling: handles the call events Meta sends to the webhook. The audio itself runs between the agent's browser and WhatsApp.
const { query } = require('./db');
const rt = require('./realtime');
const push = require('./push');
const numbers = require('./numbers');

const early = new Map(); // outgoing call answers that arrive before we have stored the call
const FINAL = ['completed', 'missed', 'rejected', 'failed', 'no_answer'];
const fmt = (s) => `${Math.floor((s || 0) / 60)}:${String((s || 0) % 60).padStart(2, '0')}`;
const convOf = async (id) => (await query('SELECT * FROM conversations WHERE id=$1', [id])).rows[0];

// Calling can be switched off per number in Settings. When off, call events are ignored completely
// (never rejected), so another system on the same number, such as Wati, keeps working undisturbed.
async function callsOn(numId) {
  const r = numId ? (await query('SELECT calls_enabled FROM wa_numbers WHERE id=$1', [numId])).rows[0] : (await query('SELECT calls_enabled FROM wa_numbers WHERE is_default')).rows[0];
  return !!(r && r.calls_enabled);
}

async function incoming(ev, value, numId) {
  const nid = numId || (await numbers.resolve(null).catch(() => ({}))).id || null;
  if (!(await callsOn(nid))) return;
  const waId = String(ev.from || '').replace(/\D/g, ''); if (!waId) return;
  const name = value.contacts && value.contacts[0] && value.contacts[0].profile && value.contacts[0].profile.name;
  const contact = (await query(
    `INSERT INTO contacts(wa_id,profile_name,source) VALUES($1,$2,'organic') ON CONFLICT (wa_id) DO UPDATE SET profile_name = COALESCE(EXCLUDED.profile_name, contacts.profile_name) RETURNING *`, [waId, name || null])).rows[0];
  if (contact.is_personal) return;
  const conv = (await query(
    `INSERT INTO conversations(contact_id, wa_number_id) VALUES($1,$2) ON CONFLICT (contact_id) DO UPDATE SET wa_number_id=COALESCE(EXCLUDED.wa_number_id, conversations.wa_number_id) RETURNING *`, [contact.id, nid])).rows[0];
  const sdp = ev.session && ev.session.sdp; if (!sdp) return;
  const c = (await query(`INSERT INTO calls(wa_call_id,conversation_id,wa_number_id,direction,status,sdp_offer) VALUES($1,$2,$3,'in','ringing',$4) ON CONFLICT (wa_call_id) DO NOTHING RETURNING *`, [ev.id, conv.id, nid, sdp])).rows[0];
  if (!c) return;
  const label = (await query('SELECT label FROM wa_numbers WHERE id=$1', [nid])).rows[0];
  rt.toConversation(conv, 'call:incoming', { id: c.id, conversationId: conv.id, assignedTo: conv.assigned_to || null, name: contact.profile_name || contact.name || '+' + waId, phone: '+' + waId, numberLabel: label && label.label });
  const targets = conv.assigned_to ? [conv.assigned_to] : (await query(`SELECT id FROM users WHERE is_active AND role <> 'agent'`)).rows.map(r => r.id);
  targets.forEach(id => push.notifyUser(id, 'Incoming WhatsApp call', contact.profile_name || contact.name || '+' + waId, { conversationId: conv.id }));
  setTimeout(async () => { // safety net if Meta's end-of-call event never arrives; only touches calls nobody picked up
    const r = (await query('SELECT status FROM calls WHERE id=$1', [c.id])).rows[0];
    if (r && r.status === 'ringing') await settle(c.id, 'missed');
  }, 70000).unref();
}

// Writes the finished call into the chat ("Missed call", "Incoming call · 3:42") and tells the screens.
async function settle(callId, wanted, ev = {}) {
  const c = (await query('SELECT * FROM calls WHERE id=$1', [callId])).rows[0]; if (!c) return;
  if (FINAL.includes(c.status) && !ev.event) return; // already closed by the real event
  let status = wanted;
  if (ev.event) {
    if (ev.status === 'FAILED') status = 'failed';
    else if (c.status === 'answered' || ev.duration > 0 || ev.start_time) status = 'completed';
    else if (c.status === 'rejected') status = 'rejected';
    else status = c.direction === 'in' ? 'missed' : 'no_answer';
  }
  const err = ev.errors && ev.errors[0] ? `${ev.errors[0].code || ''} ${ev.errors[0].message || ''}`.trim() : null;
  const up = (await query(`UPDATE calls SET status=$2, ended_at=now(), duration=COALESCE($3, duration), error=COALESCE($4, error) WHERE id=$1 RETURNING *`, [callId, status, ev.duration || null, err])).rows[0];
  const conv = await convOf(c.conversation_id); if (!conv) return;
  const dur = up.duration || 0, inbound = c.direction === 'in';
  const body = inbound ? (status === 'completed' ? `Incoming call · ${fmt(dur)}` : status === 'rejected' ? 'Declined call' : status === 'failed' ? 'Call failed' : 'Missed call')
                       : (status === 'completed' ? `Outgoing call · ${fmt(dur)}` : status === 'rejected' ? 'Call declined by client' : status === 'failed' ? 'Call failed' : 'Call not answered');
  const m = (await query(
    `INSERT INTO messages(conversation_id,direction,sender_type,sender_id,wa_message_id,type,body,status) VALUES($1,$2,$3,$4,$5,'call',$6,'sent') ON CONFLICT (wa_message_id) DO NOTHING RETURNING *`,
    [conv.id, inbound ? 'in' : 'out', inbound ? 'customer' : 'agent', inbound ? null : c.agent_id, c.wa_call_id, body])).rows[0];
  if (m) await query(`UPDATE conversations SET last_message_at=now(), unread_count = unread_count + $2 WHERE id=$1`, [conv.id, inbound && status === 'missed' ? 1 : 0]);
  const fresh = await convOf(conv.id);
  rt.toConversation(fresh, 'call:ended', { id: c.id, status, conversationId: conv.id });
  if (m) rt.toConversation(fresh, 'message:new', { conversationId: conv.id, message: m });
  if (inbound && status === 'missed' && fresh.assigned_to) push.notifyUser(fresh.assigned_to, 'Missed WhatsApp call', '', { conversationId: conv.id });
}

async function onEvent(ev, value, numId) {
  const inbound = ev.direction === 'USER_INITIATED';
  if (ev.event === 'connect') {
    if (inbound) return incoming(ev, value, numId);
    const sdp = ev.session && ev.session.sdp; if (!sdp) return;
    const c = (await query(`UPDATE calls SET sdp_answer=$2 WHERE wa_call_id=$1 RETURNING *`, [ev.id, sdp])).rows[0];
    if (!c) { early.set(ev.id, sdp); setTimeout(() => early.delete(ev.id), 30000); return; }
    if (c.agent_id) rt.toUser(c.agent_id, 'call:answer', { id: c.id, sdp });
    return;
  }
  if (ev.event === 'terminate') {
    const c = (await query('SELECT id FROM calls WHERE wa_call_id=$1', [ev.id])).rows[0];
    if (c) await settle(c.id, null, ev);
  }
}

// RINGING / ACCEPTED / REJECTED for calls we placed
async function onStatus(s) {
  const c = (await query('SELECT * FROM calls WHERE wa_call_id=$1', [s.id])).rows[0]; if (!c) return;
  const st = String(s.status || '').toUpperCase();
  if (st === 'ACCEPTED') await query(`UPDATE calls SET status='answered', started_at=COALESCE(started_at, now()) WHERE id=$1 AND status='ringing'`, [c.id]);
  if (st === 'REJECTED') await query(`UPDATE calls SET status='rejected' WHERE id=$1 AND status='ringing'`, [c.id]);
  if (c.agent_id) rt.toUser(c.agent_id, 'call:status', { id: c.id, status: st.toLowerCase() });
}

module.exports = { onEvent, onStatus, settle, early };
