// Media Library (saved files) and Quick Message (automatic keyword replies).
const express = require('express');
const { query } = require('../db');
const { required } = require('../auth');
const { windowInfo } = require('../messages');
const mediaStore = require('../media');
const autoreply = require('../autoreply');
const tenant = require('../tenant');
const C = () => tenant.cid(); // the signed-in person's company; every query below is limited to it
const router = express.Router();
const mgr = required('admin', 'manager');
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });

// How much each company may keep in its library. Change with MEDIA_LIBRARY_MAX_MB on the server (default 100).
const plan = require('../plan'); // library space comes from the company's plan; MEDIA_LIBRARY_MAX_MB applies when the plan has no limit
const FILE_COLS = `f.id, f.name, f.mime, f.size, f.created_at, (SELECT name FROM users WHERE id=f.created_by) AS added_by,
  (SELECT COUNT(*)::int FROM auto_replies a WHERE a.company_id=f.company_id AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.steps) s WHERE s->>'media_id' = f.id::text)) AS used_in`;

// ---- Media Library ----
router.get('/media-library', required(), wrap(async (req, res) => {
  const files = (await query(`SELECT ${FILE_COLS} FROM media_library f WHERE f.company_id=$1 ORDER BY f.id DESC`, [C()])).rows;
  res.json({ files: files.map(f => ({ ...f, kind: mediaStore.kindOf(f.mime) })), used: files.reduce((n, f) => n + f.size, 0), limit: (await plan.storageMb()) * 1024 * 1024 });
}));

// Raw body upload: POST /media-library?filename=..&mime=..
router.post('/media-library', mgr, express.raw({ type: () => true, limit: '16mb' }), wrap(async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'No file received' });
  const mime = String(req.query.mime || 'application/octet-stream').split(';')[0].trim().slice(0, 100);
  const name = String(req.query.filename || 'file').replace(/[\\/]/g, ' ').trim().slice(0, 120) || 'file';
  if (/^audio\//.test(mime) && !/^audio\/(aac|mp4|mpeg|amr|ogg)/.test(mime)) return res.status(415).json({ error: 'WhatsApp accepts audio only as MP3, AAC, M4A, AMR or OGG' });
  if (mediaStore.kindOf(mime) === 'image' && buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'Photos must be under 5 MB' });
  const used = Number((await query('SELECT COALESCE(SUM(size),0) AS n FROM media_library WHERE company_id=$1', [C()])).rows[0].n);
  const maxMb = await plan.storageMb();
  if (used + buf.length > maxMb * 1024 * 1024) return res.status(413).json({ error: `Your library is full (${maxMb} MB). Delete files you no longer need.` });
  const f = (await query('INSERT INTO media_library(company_id,name,mime,size,data,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,mime,size,created_at',
    [C(), name, mime, buf.length, buf, req.user.id])).rows[0];
  res.json({ ...f, kind: mediaStore.kindOf(f.mime) });
}));

router.get('/media-library/:id/file', required(), wrap(async (req, res) => {
  const f = (await query('SELECT name,mime,data FROM media_library WHERE id=$1 AND company_id=$2', [Number(req.params.id) || 0, C()])).rows[0];
  if (!f) return res.status(404).json({ error: 'not found' });
  res.set({ 'Content-Type': f.mime, 'Cache-Control': 'private, max-age=86400', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}` });
  res.send(f.data);
}));

router.patch('/media-library/:id', mgr, wrap(async (req, res) => {
  const name = String(req.body.name || '').replace(/[\\/]/g, ' ').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const f = (await query('UPDATE media_library SET name=$3 WHERE id=$1 AND company_id=$2 RETURNING id,name', [Number(req.params.id) || 0, C(), name])).rows[0];
  if (!f) return res.status(404).json({ error: 'not found' });
  res.json(f);
}));

router.delete('/media-library/:id', mgr, wrap(async (req, res) => {
  await query('DELETE FROM media_library WHERE id=$1 AND company_id=$2', [Number(req.params.id) || 0, C()]);
  res.json({ ok: true });
}));

// Send a saved file into a chat (any agent, in their own chats; same 24h rule as other messages)
router.post('/conversations/:id/library/:fileId', required(), wrap(async (req, res) => {
  const c = (await query('SELECT c.*, ct.wa_id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=$1 AND c.company_id=$2', [Number(req.params.id) || 0, C()])).rows[0];
  if (!c) return res.status(404).json({ error: 'not found' });
  if (req.user.role === 'agent' && c.assigned_to !== req.user.id) return res.status(403).json({ error: 'not your conversation' });
  if (!windowInfo(c).window_open) return res.status(409).json({ error: 'The reply window is closed. Send an approved template first.', code: 'WINDOW_CLOSED' });
  const f = (await query('SELECT * FROM media_library WHERE id=$1 AND company_id=$2', [Number(req.params.fileId) || 0, C()])).rows[0];
  if (!f) return res.status(404).json({ error: 'This file is no longer in the library' });
  try {
    const m = await autoreply.sendLibraryFile(c, c.wa_id, f, { caption: String(req.body.caption || '').trim().slice(0, 1000), senderType: 'agent', senderId: req.user.id });
    await query('UPDATE conversations SET unread_count=0, escalated_at=NULL WHERE id=$1', [c.id]);
    res.json(m);
  } catch (e) { res.status(502).json({ error: e.message }); }
}));

// ---- Quick Message ----
const TYPES = ['text', 'image', 'video', 'audio', 'file', 'product'];
// Checks a rule sent from the page and returns it in the shape that is stored. WhatsApp's own limits are applied here.
const clean = async (b) => {
  const str = (x, n) => String(x == null ? '' : x).trim().slice(0, n);
  const seen = new Set(); // the same keyword twice (in any letter case) is kept once
  const keywords = (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(',')).map(k => str(k, 300).replace(/\s+/g, ' ')).filter(k => k && !seen.has(k.toLowerCase()) && seen.add(k.toLowerCase())).slice(0, 30);
  const name = str(b.name, 80);
  if (!name) return { error: 'Give this quick message a name' };
  if (!keywords.length) return { error: 'Add at least one keyword or message that starts it' };
  const raw = Array.isArray(b.steps) ? b.steps.slice(0, 10) : [];
  if (!raw.length) return { error: 'Add at least one message to send' };
  const ids = [...new Set(raw.map(s => Number(s.media_id)).filter(Boolean))];
  const files = ids.length ? (await query('SELECT id, mime FROM media_library WHERE company_id=$1 AND id = ANY($2::int[])', [C(), ids])).rows : [];
  const pids = [...new Set(raw.map(s => Number(s.product_id)).filter(Boolean))];
  const products = pids.length ? (await query('SELECT id FROM products WHERE company_id=$1 AND id = ANY($2::int[])', [C(), pids])).rows : [];
  const steps = [];
  for (const [i, s] of raw.entries()) {
    const n = `Message ${i + 1}`, type = TYPES.includes(s.type) ? s.type : 'text', text = str(s.text, 1000);
    const step = { type, text, delay: Math.min(60, Math.max(0, Math.round(Number(s.delay) || 0))) };
    if (type === 'product') { // the product's own photo, price and details are the message
      if (!products.some(x => x.id === Number(s.product_id))) return { error: `${n}: choose a product from your catalog` };
      steps.push({ type, product_id: Number(s.product_id), text: '', delay: step.delay }); continue;
    }
    if (type !== 'text') {
      const f = files.find(x => x.id === Number(s.media_id));
      if (!f) return { error: `${n}: choose a file from the Media Library` };
      const kind = mediaStore.kindOf(f.mime);
      if (type !== 'file' && kind !== type) return { error: `${n}: the chosen file is not ${type === 'image' ? 'a photo (JPG or PNG)' : type === 'video' ? 'a video (MP4)' : 'an audio file'}. Choose another file or use the File type.` };
      step.media_id = f.id;
    } else if (!text) return { error: `${n}: type the text` };
    const btns = (Array.isArray(s.buttons) ? s.buttons : []).map(x => ({ type: x.type === 'url' ? 'url' : 'reply', title: str(x.title, 20), url: str(x.url, 500) })).filter(x => x.title || x.url).slice(0, 3);
    if (btns.length) {
      if (type === 'audio') return { error: `${n}: WhatsApp does not allow buttons on audio. Put them on a text message after it.` };
      if (!text) return { error: `${n}: a message with buttons needs text` };
      if (btns.some(x => !x.title)) return { error: `${n}: every button needs a name` };
      const links = btns.filter(x => x.type === 'url');
      if (links.length && btns.length > 1) return { error: `${n}: WhatsApp allows one website link button per message, and not together with reply buttons` };
      if (links.length && !/^https:\/\/[^\s]+\.[^\s]+$/i.test(links[0].url)) return { error: `${n}: the website link must start with https://` };
      step.buttons = btns.map(x => x.type === 'url' ? x : { type: 'reply', title: x.title });
    }
    steps.push(step);
  }
  const tag_id = Number(b.tag_id) || null, assign_to = Number(b.assign_to) || null;
  if (tag_id && !(await query('SELECT 1 FROM labels WHERE id=$1 AND company_id=$2', [tag_id, C()])).rows[0]) return { error: 'The chosen tag no longer exists' };
  if (assign_to && !(await query('SELECT 1 FROM users WHERE id=$1 AND company_id=$2 AND is_active', [assign_to, C()])).rows[0]) return { error: 'The chosen agent is not active' };
  return { name, keywords, match_type: b.match_type === 'contains' ? 'contains' : 'exact', steps, tag_id, assign_to, respect_opt_out: b.respect_opt_out !== false };
};
const RULE_COLS = `a.id, a.name, a.keywords, a.match_type, a.steps, a.tag_id, a.assign_to, a.respect_opt_out, a.active, a.sent_count, a.last_sent_at, a.created_at,
  (SELECT name FROM labels WHERE id=a.tag_id) AS tag_name, (SELECT name FROM users WHERE id=a.assign_to) AS agent_name`;
const vals = (v) => [v.name, JSON.stringify(v.keywords), v.match_type, JSON.stringify(v.steps), v.tag_id, v.assign_to, v.respect_opt_out];
router.get('/auto-replies', mgr, wrap(async (req, res) => res.json((await query(`SELECT ${RULE_COLS} FROM auto_replies a WHERE a.company_id=$1 ORDER BY a.id DESC`, [C()])).rows)));
router.post('/auto-replies', mgr, wrap(async (req, res) => {
  const v = await clean(req.body); if (v.error) return res.status(400).json(v);
  res.json((await query('INSERT INTO auto_replies(company_id,name,keywords,match_type,steps,tag_id,assign_to,respect_opt_out) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [C(), ...vals(v)])).rows[0]);
}));
router.patch('/auto-replies/:id', mgr, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (Object.keys(req.body).length === 1 && 'active' in req.body) { // the on/off switch
    const r = (await query('UPDATE auto_replies SET active=$3 WHERE id=$1 AND company_id=$2 RETURNING id, active', [id, C(), !!req.body.active])).rows[0];
    return r ? res.json(r) : res.status(404).json({ error: 'not found' });
  }
  const v = await clean(req.body); if (v.error) return res.status(400).json(v);
  const r = (await query('UPDATE auto_replies SET name=$3, keywords=$4, match_type=$5, steps=$6, tag_id=$7, assign_to=$8, respect_opt_out=$9 WHERE id=$1 AND company_id=$2 RETURNING *', [id, C(), ...vals(v)])).rows[0];
  r ? res.json(r) : res.status(404).json({ error: 'not found' });
}));
router.delete('/auto-replies/:id', mgr, wrap(async (req, res) => {
  await query('DELETE FROM auto_replies WHERE id=$1 AND company_id=$2', [Number(req.params.id) || 0, C()]);
  res.json({ ok: true });
}));

module.exports = router;
