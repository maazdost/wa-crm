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
const settings = require('../settings');
const { markPersonal } = require('../personal');
const bot = require('../bot');
const LABELS_SQL = `(SELECT COALESCE(json_agg(json_build_object('id',l.id,'name',l.name,'color',l.color)),'[]'::json) FROM conversation_labels cl JOIN labels l ON l.id=cl.label_id WHERE cl.conversation_id=c.id) AS labels`;

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
    `SELECT c.*, ct.wa_id, COALESCE(ct.profile_name, ct.name) AS contact_name, ${LABELS_SQL} FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=$1`,
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
  where.push(req.query.held === 'true' ? "c.bot_step='held'" : "c.bot_step <> 'held'");
  if (req.query.label) { p.push(Number(req.query.label)); where.push(`EXISTS (SELECT 1 FROM conversation_labels cl WHERE cl.conversation_id=c.id AND cl.label_id=$${p.length})`); }
  if (q) { p.push(`%${q}%`); where.push(`(ct.name ILIKE $${p.length} OR ct.profile_name ILIKE $${p.length} OR ct.wa_id ILIKE $${p.length})`); }
  const { rows } = await query(
    `SELECT c.*, ct.wa_id, COALESCE(ct.profile_name, ct.name) AS contact_name, u.name AS agent_name, ${LABELS_SQL},
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
  if (t.status !== 'APPROVED' && process.env.WA_DRY_RUN !== 'true') return res.status(409).json({ error: 'Meta has not approved this template yet' });
  const params = t.var_count === 0 ? [] : (req.body.params?.length ? req.body.params : [(c.contact_name || 'there').split(' ')[0]]);
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
  if (c.unread_count > 0 && c.assigned_to === req.user.id) {
    const last = (await query(`SELECT wa_message_id FROM messages WHERE conversation_id=$1 AND direction='in' AND wa_message_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [c.id])).rows[0];
    if (last) wa.markRead(last.wa_message_id); // blue ticks: the client sees that a person has read it
  }
  res.json({ ok: true });
}));

// "typing..." on the client's phone while the owning agent writes (at most once every 15 s per chat)
const typingAt = new Map();
router.post('/conversations/:id/typing', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  if (c.assigned_to !== req.user.id || !windowInfo(c).window_open || Date.now() - (typingAt.get(c.id) || 0) < 15000) return res.json({ ok: true, skipped: true });
  const last = (await query(`SELECT wa_message_id FROM messages WHERE conversation_id=$1 AND direction='in' AND wa_message_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [c.id])).rows[0];
  if (!last) return res.json({ ok: true, skipped: true });
  typingAt.set(c.id, Date.now());
  wa.typing(last.wa_message_id).catch(() => {});
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
    conv = (await query(`UPDATE conversations SET assigned_to=$2, status='open', assigned_at=now() WHERE id=$1 RETURNING *`, [id, req.body.agent_id])).rows[0];
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

// ---- Not a client / held senders ----
router.post('/conversations/:id/not-client', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  await markPersonal(c.contact_id); res.json({ ok: true });
}));
router.post('/conversations/:id/release', required('admin', 'manager'), wrap(async (req, res) => {
  const c = (await query(`UPDATE conversations SET status='bot', bot_step='new' WHERE id=$1 AND bot_step='held' RETURNING *`, [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ error: 'This chat is not on hold' });
  const contact = (await query('SELECT * FROM contacts WHERE id=$1', [c.contact_id])).rows[0];
  await bot.handle(c, contact, { type: 'text', body: '' }); res.json({ ok: true });
}));

// ---- Settings: bot wording and away message ----
router.get('/settings', required('admin', 'manager'), wrap(async (req, res) => res.json({ bot: await settings.get('bot'), away: await settings.get('away'), gate: await settings.get('gate') })));
router.put('/settings/:key', required('admin', 'manager'), wrap(async (req, res) => {
  const k = req.params.key, b = req.body || {};
  if (k === 'bot') {
    const v = {};
    for (const f of ['greet', 'askName', 'handoff', 'btnInfo', 'btnTeam', 'btnClasses'])
      if (typeof b[f] === 'string' && b[f].trim()) v[f] = b[f].trim().slice(0, f.startsWith('btn') ? 20 : 600);
    await settings.set('bot', { ...(await settings.get('bot')), ...v });
  } else if (k === 'away') {
    const cur = await settings.get('away');
    const days = Array.isArray(b.days) ? b.days.map(Number).filter(n => n >= 0 && n <= 6) : cur.days;
    await settings.set('away', { ...cur, enabled: !!b.enabled, message: String(b.message || cur.message).slice(0, 600), days,
      start: /^\d\d:\d\d$/.test(b.start) ? b.start : cur.start, end: /^\d\d:\d\d$/.test(b.end) ? b.end : cur.end });
  } else if (k === 'gate') {
    const kw = (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(',')).map(x => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 50);
    await settings.set('gate', { mode: b.mode === 'keywords' ? 'keywords' : 'all', keywords: kw });
  } else return res.status(404).json({ error: 'unknown setting' });
  res.json({ ok: true });
}));

// ---- Quick replies ----
router.get('/quick-replies', required(), wrap(async (req, res) => res.json((await query('SELECT id,shortcut,title,body FROM quick_replies ORDER BY shortcut')).rows)));
router.post('/quick-replies', required('admin', 'manager'), wrap(async (req, res) => {
  const { shortcut, title, body } = req.body;
  if (!shortcut || !title || !body) return res.status(400).json({ error: 'Shortcut, title and text are required' });
  res.json((await query('INSERT INTO quick_replies(shortcut,title,body) VALUES($1,$2,$3) RETURNING *',
    [String(shortcut).trim().replace(/^\/+/, '').slice(0, 30).replace(/\s+/g, '-'), String(title).slice(0, 80), String(body).slice(0, 1000)])).rows[0]);
}));
router.delete('/quick-replies/:id', required('admin', 'manager'), wrap(async (req, res) => { await query('DELETE FROM quick_replies WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

// ---- Labels ----
router.get('/labels', required(), wrap(async (req, res) => res.json((await query('SELECT * FROM labels ORDER BY name')).rows)));
router.post('/labels', required('admin', 'manager'), wrap(async (req, res) => {
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color) ? req.body.color : '#0e5a4a';
  res.json((await query('INSERT INTO labels(name,color) VALUES($1,$2) RETURNING *', [String(req.body.name || '').trim().slice(0, 30), color])).rows[0]);
}));
router.delete('/labels/:id', required('admin', 'manager'), wrap(async (req, res) => { await query('DELETE FROM labels WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));
router.post('/conversations/:id/labels', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  const lid = Number(req.body.label_id);
  if (req.body.on) await query('INSERT INTO conversation_labels VALUES($1,$2) ON CONFLICT DO NOTHING', [c.id, lid]);
  else await query('DELETE FROM conversation_labels WHERE conversation_id=$1 AND label_id=$2', [c.id, lid]);
  res.json({ ok: true });
}));

router.get('/analytics', required('admin', 'manager'), wrap(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 14, 1), 90), d = String(days);
  const tz = process.env.REPORT_TZ || 'Asia/Karachi';
  const since = `now() - ($1 || ' days')::interval`;
  const [kpi, perDay, intents, sources, agents, msgs, med] = await Promise.all([
    query(`SELECT COUNT(*) FILTER (WHERE created_at > ${since})::int AS new_chats,
        COUNT(*) FILTER (WHERE status='open')::int AS open,
        COUNT(*) FILTER (WHERE assigned_to IS NULL AND bot_step='done')::int AS unassigned,
        COUNT(*) FILTER (WHERE status='bot')::int AS with_bot,
        COUNT(*) FILTER (WHERE status='closed')::int AS closed FROM conversations`, [d]),
    query(`SELECT to_char(g,'YYYY-MM-DD') AS day, COALESCE(x.n,0)::int AS chats
        FROM generate_series(((now() AT TIME ZONE $2)::date - ($1::int - 1))::timestamp, (now() AT TIME ZONE $2)::date::timestamp, interval '1 day') g
        LEFT JOIN (SELECT (created_at AT TIME ZONE $2)::date AS dd, COUNT(*) AS n FROM conversations GROUP BY 1) x ON x.dd = g::date ORDER BY g`, [days, tz]),
    query(`SELECT COALESCE(intent,'unknown') AS k, COUNT(*)::int AS n FROM conversations WHERE created_at > ${since} GROUP BY 1 ORDER BY n DESC`, [d]),
    query(`SELECT COALESCE(ct.source,'organic') AS k, COUNT(*)::int AS n FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.created_at > ${since} GROUP BY 1 ORDER BY n DESC`, [d]),
    query(`SELECT u.id, u.name, u.team, COUNT(c.id)::int AS assigned, COUNT(c.first_reply)::int AS replied,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (c.first_reply - c.assigned_at))) AS median_reply_sec,
        (SELECT COUNT(*) FROM messages m WHERE m.sender_id=u.id AND m.sender_type='agent' AND m.created_at > ${since})::int AS msgs_sent,
        (SELECT COUNT(*) FROM conversations o WHERE o.assigned_to=u.id AND o.status='open')::int AS open_now,
        (SELECT COALESCE(SUM(unread_count),0) FROM conversations o WHERE o.assigned_to=u.id)::int AS unread
      FROM users u LEFT JOIN LATERAL (
        SELECT c2.id, c2.assigned_at, (SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id=c2.id AND m.sender_type='agent' AND m.created_at >= c2.assigned_at) AS first_reply
        FROM conversations c2 WHERE c2.assigned_to=u.id AND c2.assigned_at > ${since}) c ON TRUE
      WHERE u.role='agent' AND u.is_active GROUP BY u.id ORDER BY assigned DESC, u.name`, [d]),
    query(`SELECT COUNT(*) FILTER (WHERE direction='in')::int AS inbound, COUNT(*) FILTER (WHERE sender_type='agent')::int AS agent_out,
        COUNT(*) FILTER (WHERE sender_type='bot')::int AS bot_out FROM messages WHERE created_at > ${since}`, [d]),
    query(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (fr - assigned_at))) AS sec FROM (
        SELECT assigned_at, (SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id=c.id AND m.sender_type='agent' AND m.created_at >= c.assigned_at) AS fr
        FROM conversations c WHERE assigned_at > ${since}) t WHERE fr IS NOT NULL`, [d])
  ]);
  res.json({ days, kpi: kpi.rows[0], perDay: perDay.rows, intents: intents.rows, sources: sources.rows, agents: agents.rows, messages: msgs.rows[0], median_reply_sec: med.rows[0].sec });
}));

module.exports = router;
