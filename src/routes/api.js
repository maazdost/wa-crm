const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { sign, required } = require('../auth');
const wa = require('../whatsapp');
const { saveOutbound, windowInfo } = require('../messages');
const { assignConversation } = require('../assign');
const rt = require('../realtime');
const mediaStore = require('../media');
const push = require('../push');
const router = express.Router();
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });
const isAgent = (u) => u.role === 'agent';

router.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body;
  const u = (await query('SELECT * FROM users WHERE email=$1 AND is_active', [String(email || '').toLowerCase()])).rows[0];
  if (!u || !(await bcrypt.compare(password || '', u.password_hash))) return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ token: sign(u), user: { id: u.id, name: u.name, role: u.role, team: u.team } });
}));

router.get('/me', required(), wrap(async (req, res) => {
  const u = (await query('SELECT id,name,email,role,team FROM users WHERE id=$1', [req.user.id])).rows[0];
  res.json(u);
}));

// ---- Conversations: agents only ever see their own ----
async function loadConversation(req, res) {
  const c = (await query(
    `SELECT c.*, ct.wa_id, ct.name AS contact_name FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=$1`,
    [req.params.id])).rows[0];
  if (!c) { res.status(404).json({ error: 'not found' }); return null; }
  if (isAgent(req.user) && c.assigned_to !== req.user.id) { res.status(403).json({ error: 'not your conversation' }); return null; }
  return c;
}

router.get('/conversations', required(), wrap(async (req, res) => {
  const { status, assigned_to, q, unassigned } = req.query;
  const where = ['TRUE'], p = [];
  if (isAgent(req.user)) { p.push(req.user.id); where.push(`c.assigned_to=$${p.length}`); }
  else if (assigned_to) { p.push(assigned_to); where.push(`c.assigned_to=$${p.length}`); }
  if (unassigned === 'true') where.push(`c.assigned_to IS NULL AND c.bot_step='done'`);
  if (status) { p.push(status); where.push(`c.status=$${p.length}`); }
  else if (!unassigned) where.push(`c.status <> 'bot'`);
  if (q) { p.push(`%${q}%`); where.push(`(ct.name ILIKE $${p.length} OR ct.wa_id ILIKE $${p.length})`); }
  const { rows } = await query(
    `SELECT c.*, ct.wa_id, ct.name AS contact_name, u.name AS agent_name,
            (SELECT body FROM messages m WHERE m.conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_body
       FROM conversations c JOIN contacts ct ON ct.id=c.contact_id LEFT JOIN users u ON u.id=c.assigned_to
      WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC LIMIT 200`, p);
  res.json(rows.map(r => ({ ...r, ...windowInfo(r) })));
}));

router.get('/conversations/:id/messages', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  const before = req.query.before ? Number(req.query.before) : 9e15;
  const { rows } = await query(
    `SELECT * FROM messages WHERE conversation_id=$1 AND id<$2 ORDER BY id DESC LIMIT 50`, [c.id, before]);
  const notes = (await query(`SELECT n.*, u.name AS author FROM notes n JOIN users u ON u.id=n.user_id WHERE conversation_id=$1 ORDER BY n.id`, [c.id])).rows;
  res.json({ conversation: { ...c, ...windowInfo(c) }, messages: rows.reverse(), notes });
}));

router.post('/conversations/:id/messages', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!windowInfo(c).window_open)
    return res.status(409).json({ error: 'The 24-hour reply window is closed. Send an approved template to reopen the chat.', code: 'WINDOW_CLOSED' });
  try {
    const r = await wa.sendText(c.wa_id, text);
    const m = await saveOutbound(c, { senderType: 'agent', senderId: req.user.id, body: text, waMessageId: r.messages?.[0]?.id });
    await query('UPDATE conversations SET unread_count=0, escalated_at=NULL WHERE id=$1', [c.id]);
    res.json(m);
  } catch (e) { res.status(502).json({ error: e.message }); }
}));

router.post('/conversations/:id/template', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  const t = (await query('SELECT * FROM templates WHERE name=$1', [req.body.name])).rows[0];
  if (!t) return res.status(404).json({ error: 'template not found' });
  const params = req.body.params?.length ? req.body.params : [c.contact_name || 'there'];
  try {
    const r = await wa.sendTemplate(c.wa_id, t.name, t.language, params);
    const body = params.reduce((s, v, i) => s.replace(`{{${i + 1}}}`, v), t.body);
    const m = await saveOutbound(c, { senderType: 'agent', senderId: req.user.id, type: 'template', body, templateName: t.name, waMessageId: r.messages?.[0]?.id });
    res.json(m);
  } catch (e) { res.status(502).json({ error: e.message }); }
}));

router.post('/conversations/:id/read', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  await query('UPDATE conversations SET unread_count=0 WHERE id=$1', [c.id]);
  res.json({ ok: true });
}));

router.post('/conversations/:id/notes', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  const { rows } = await query('INSERT INTO notes(conversation_id,user_id,body) VALUES($1,$2,$3) RETURNING *', [c.id, req.user.id, req.body.body]);
  res.json(rows[0]);
}));

router.post('/conversations/:id/status', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  if (!['open', 'closed'].includes(req.body.status)) return res.status(400).json({ error: 'bad status' });
  await query('UPDATE conversations SET status=$2 WHERE id=$1', [c.id, req.body.status]);
  res.json({ ok: true });
}));

// Managers: reassign (to a chosen agent, or auto-pick when agent_id omitted)
router.post('/conversations/:id/reassign', required('admin', 'manager'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  let conv;
  if (req.body.agent_id) {
    conv = (await query(`UPDATE conversations SET assigned_to=$2, status='open' WHERE id=$1 RETURNING *`, [id, req.body.agent_id])).rows[0];
  } else {
    const cur = (await query('SELECT team FROM conversations WHERE id=$1', [id])).rows[0];
    conv = await assignConversation(id, cur?.team);
  }
  if (!conv) return res.status(409).json({ error: 'No agent available' });
  rt.toUser(conv.assigned_to, 'conversation:assigned', { conversationId: id });
  push.notifyUser(conv.assigned_to, 'Chat assigned to you', 'A manager assigned you a client.', { conversationId: id });
  res.json(conv);
}));

// ---- Media ----
// Raw body upload: POST /conversations/:id/media?filename=..&mime=..&caption=..
router.post('/conversations/:id/media', required(), express.raw({ type: () => true, limit: '16mb' }), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  if (!windowInfo(c).window_open)
    return res.status(409).json({ error: 'The reply window is closed. Send an approved template first.', code: 'WINDOW_CLOSED' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'No file received' });
  const mime = String(req.query.mime || 'application/octet-stream');
  const filename = String(req.query.filename || 'file').slice(0, 120);
  const caption = String(req.query.caption || '').trim().slice(0, 1000);
  const kind = mediaStore.kindOf(mime);
  if (kind === 'image' && buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'Photos must be under 5 MB' });
  try {
    const up = await wa.uploadMedia(buf, mime, filename);
    const sent = await wa.sendMedia(c.wa_id, kind, up.id, { caption, filename });
    await mediaStore.store(up.id, mime, buf);
    const m = await saveOutbound(c, { senderType: 'agent', senderId: req.user.id, type: kind, body: caption || `[${kind}]`,
      waMessageId: sent.messages?.[0]?.id, mediaId: up.id, mediaMime: mime, mediaName: filename });
    await query('UPDATE conversations SET unread_count=0, escalated_at=NULL WHERE id=$1', [c.id]);
    res.json(m);
  } catch (e) { res.status(502).json({ error: e.message }); }
}));

router.get('/messages/:id/media', required(), wrap(async (req, res) => {
  const m = (await query(`SELECT m.*, c.assigned_to FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=$1`, [req.params.id])).rows[0];
  if (!m || !m.media_id) return res.status(404).json({ error: 'not found' });
  if (isAgent(req.user) && m.assigned_to !== req.user.id) return res.status(403).json({ error: 'not your conversation' });
  try {
    const f = await mediaStore.ensure(m.media_id);
    res.set({ 'Content-Type': f.mime || m.media_mime || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(m.media_name || 'file')}` });
    res.send(f.data);
  } catch (e) { res.status(404).json({ error: 'This file is no longer available' }); }
}));

// ---- Phone push tokens ----
router.post('/devices', required(), wrap(async (req, res) => {
  if (!req.body.token) return res.status(400).json({ error: 'token required' });
  await query(`INSERT INTO devices(user_id,token) VALUES($1,$2) ON CONFLICT (token) DO UPDATE SET user_id=EXCLUDED.user_id`, [req.user.id, req.body.token]);
  res.json({ ok: true });
}));
router.post('/devices/remove', required(), wrap(async (req, res) => {
  await query('DELETE FROM devices WHERE token=$1 AND user_id=$2', [req.body.token, req.user.id]); res.json({ ok: true });
}));

// ---- Admin: users, templates, stats ----
router.get('/users', required('admin', 'manager'), wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id,u.name,u.email,u.role,u.team,u.is_active,u.is_online,u.max_active_chats,
            (SELECT COUNT(*) FROM conversations c WHERE c.assigned_to=u.id AND c.status='open')::int AS active_chats
       FROM users u ORDER BY u.id`);
  res.json(rows);
}));
router.post('/users', required('admin'), wrap(async (req, res) => {
  const { name, email, password, role = 'agent', team = 'general', max_active_chats = 150 } = req.body;
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO users(name,email,password_hash,role,team,max_active_chats) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role,team`,
    [name, String(email).toLowerCase(), hash, role, team, max_active_chats]);
  res.json(rows[0]);
}));
router.patch('/users/:id', required('admin'), wrap(async (req, res) => {
  const f = ['name', 'role', 'team', 'is_active', 'max_active_chats'].filter(k => k in req.body);
  if (req.body.password) { await query('UPDATE users SET password_hash=$2 WHERE id=$1', [req.params.id, await bcrypt.hash(req.body.password, 10)]); }
  if (f.length) await query(`UPDATE users SET ${f.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1`, [req.params.id, ...f.map(k => req.body[k])]);
  res.json({ ok: true });
}));

router.get('/templates', required(), wrap(async (req, res) => res.json((await query('SELECT * FROM templates ORDER BY name')).rows)));
router.post('/templates', required('admin'), wrap(async (req, res) => {
  const { name, language = 'en', body, category = 'utility' } = req.body;
  res.json((await query('INSERT INTO templates(name,language,body,category) VALUES($1,$2,$3,$4) RETURNING *', [name, language, body, category])).rows[0]);
}));

router.get('/stats', required('admin', 'manager'), wrap(async (req, res) => {
  const totals = (await query(`SELECT
      COUNT(*) FILTER (WHERE status='open')::int AS open,
      COUNT(*) FILTER (WHERE status='closed')::int AS closed,
      COUNT(*) FILTER (WHERE status='bot')::int AS with_bot,
      COUNT(*) FILTER (WHERE assigned_to IS NULL AND bot_step='done')::int AS unassigned,
      COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS new_24h FROM conversations`)).rows[0];
  const agents = (await query(`SELECT u.id,u.name,u.team,u.is_online,
      COUNT(c.id) FILTER (WHERE c.status='open')::int AS open_chats,
      COALESCE(SUM(c.unread_count),0)::int AS unread
      FROM users u LEFT JOIN conversations c ON c.assigned_to=u.id WHERE u.role='agent' GROUP BY u.id ORDER BY u.name`)).rows;
  res.json({ totals, agents });
}));

module.exports = router;
