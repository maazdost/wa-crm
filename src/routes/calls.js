const express = require('express');
const { query } = require('../db');
const { required } = require('../auth');
const wa = require('../whatsapp');
const rt = require('../realtime');
const calls = require('../calls');
const { saveOutbound, windowInfo } = require('../messages');
const router = express.Router();
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });
const isAgent = (u) => u.role === 'agent';

// Agents only handle their own chats; managers and admins can handle any.
async function loadCall(req, res) {
  const c = (await query(`SELECT c.*, v.assigned_to, v.status AS conv_status FROM calls c JOIN conversations v ON v.id=c.conversation_id WHERE c.id=$1`, [req.params.id])).rows[0];
  if (!c) { res.status(404).json({ error: 'Call not found' }); return null; }
  if (isAgent(req.user) && c.assigned_to !== req.user.id) { res.status(403).json({ error: 'This call is not for you' }); return null; }
  return c;
}
async function loadConv(req, res) {
  const c = (await query(`SELECT c.*, ct.wa_id, COALESCE(ct.profile_name, ct.name) AS contact_name FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=$1`, [req.params.id])).rows[0];
  if (!c) { res.status(404).json({ error: 'not found' }); return null; }
  if (isAgent(req.user) && c.assigned_to !== req.user.id) { res.status(403).json({ error: 'not your conversation' }); return null; }
  return c;
}
const numberOn = async (conv) => {
  const r = conv.wa_number_id ? (await query('SELECT calls_enabled FROM wa_numbers WHERE id=$1', [conv.wa_number_id])).rows[0] : (await query('SELECT calls_enabled FROM wa_numbers WHERE is_default')).rows[0];
  return !!(r && r.calls_enabled);
};

router.get('/calls/:id', required(), wrap(async (req, res) => {
  const c = await loadCall(req, res); if (!c) return;
  res.json({ id: c.id, status: c.status, direction: c.direction, sdp_offer: c.status === 'ringing' && c.direction === 'in' ? c.sdp_offer : null, sdp_answer: c.sdp_answer });
}));

// Answer an incoming call. The first person to answer gets it.
router.post('/calls/:id/accept', required(), wrap(async (req, res) => {
  const c = await loadCall(req, res); if (!c) return;
  const sdp = String(req.body.sdp || ''); if (!sdp) return res.status(400).json({ error: 'No audio session received' });
  const claim = (await query(`UPDATE calls SET status='answered', agent_id=$2, started_at=now() WHERE id=$1 AND status='ringing' AND direction='in' RETURNING *`, [c.id, req.user.id])).rows[0];
  if (!claim) return res.status(409).json({ code: 'CALL_GONE', error: 'This call was already answered or has ended.' });
  const w = wa.forNumber(c.wa_number_id);
  try {
    const session = { sdp_type: 'answer', sdp };
    await w.callAction({ call_id: c.wa_call_id, action: 'pre_accept', session }).catch(e => console.warn('pre_accept:', e.message));
    await w.callAction({ call_id: c.wa_call_id, action: 'accept', session });
  } catch (e) {
    await calls.settle(c.id, 'failed', { errors: [{ message: String(e.message).slice(0, 200) }] });
    return res.status(502).json({ error: 'WhatsApp could not connect the call: ' + e.message });
  }
  rt.toConversation({ assigned_to: c.assigned_to }, 'call:taken', { id: c.id, by: req.user.id });
  res.json({ ok: true });
}));

router.post('/calls/:id/reject', required(), wrap(async (req, res) => {
  const c = await loadCall(req, res); if (!c) return;
  const claim = (await query(`UPDATE calls SET status='rejected' WHERE id=$1 AND status='ringing' AND direction='in' RETURNING id`, [c.id])).rows[0];
  if (!claim) return res.json({ ok: true });
  await wa.forNumber(c.wa_number_id).callAction({ call_id: c.wa_call_id, action: 'reject' }).catch(e => console.warn('reject:', e.message));
  rt.toConversation({ assigned_to: c.assigned_to }, 'call:taken', { id: c.id, by: req.user.id });
  res.json({ ok: true });
}));

router.post('/calls/:id/hangup', required(), wrap(async (req, res) => {
  const c = await loadCall(req, res); if (!c) return;
  if (c.wa_call_id) await wa.forNumber(c.wa_number_id).callAction({ call_id: c.wa_call_id, action: 'terminate' }).catch(e => console.warn('terminate:', e.message));
  res.json({ ok: true });
}));

// Start a call to the client. The browser sends its audio offer; the client must have allowed calls.
router.post('/conversations/:id/call', required(), wrap(async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  if (!(await numberOn(conv))) return res.status(409).json({ error: 'Calling is turned off for this number.' });
  const sdp = String(req.body.sdp || ''); if (!sdp) return res.status(400).json({ error: 'No audio session received' });
  let r;
  try { r = await wa.forConversation(conv).callAction({ to: conv.wa_id, action: 'connect', session: { sdp_type: 'offer', sdp } }); }
  catch (e) {
    if (e.code === 138006) return res.status(409).json({ code: 'NO_PERMISSION', error: 'This client has not allowed calls yet.' });
    return res.status(502).json({ error: e.message });
  }
  const waCallId = r.calls && r.calls[0] && r.calls[0].id;
  const c = (await query(`INSERT INTO calls(wa_call_id,conversation_id,wa_number_id,direction,status,agent_id) VALUES($1,$2,$3,'out','ringing',$4) RETURNING *`, [waCallId, conv.id, conv.wa_number_id, req.user.id])).rows[0];
  const ans = calls.early.get(waCallId);
  if (ans) { calls.early.delete(waCallId); await query('UPDATE calls SET sdp_answer=$2 WHERE id=$1', [c.id, ans]); rt.toUser(req.user.id, 'call:answer', { id: c.id, sdp: ans }); }
  res.json({ id: c.id });
}));

// Ask the client for permission to call (a normal WhatsApp message with an Allow button; needs an open 24-hour window)
router.post('/conversations/:id/call-permission', required(), wrap(async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  if (!(await numberOn(conv))) return res.status(409).json({ error: 'Calling is turned off for this number.' });
  if (!windowInfo(conv).window_open) return res.status(409).json({ error: 'The 24-hour reply window is closed. Send an approved template first, then ask again.', code: 'WINDOW_CLOSED' });
  const text = 'May we call you on WhatsApp to help with your request?';
  try {
    const r = await wa.forConversation(conv).sendCallPermission(conv.wa_id, text);
    const m = await saveOutbound(conv, { senderType: 'agent', senderId: req.user.id, body: '📞 Asked permission to call', waMessageId: r.messages && r.messages[0] && r.messages[0].id });
    res.json(m);
  } catch (e) { res.status(502).json({ error: e.message }); }
}));

module.exports = router;
