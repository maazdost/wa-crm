const express = require('express');
const { query } = require('../db');
const { required } = require('../auth');
const wa = require('../whatsapp');
const { audience, paramsFor } = require('../broadcast');
const router = express.Router();
const mgr = required('admin', 'manager');
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });
const varCount = (b) => Math.max(0, ...[...String(b).matchAll(/\{\{(\d+)\}\}/g)].map(m => +m[1]));
const DRY = () => process.env.WA_DRY_RUN === 'true';

// ---- Templates ----
router.post('/templates', mgr, wrap(async (req, res) => {
  const { name, category = 'MARKETING', language = 'en', body, examples = [], footer, buttons = [] } = req.body;
  if (!/^[a-z0-9_]{1,60}$/.test(name || '')) return res.status(400).json({ error: 'Name may only contain lowercase letters, numbers and underscores' });
  if (!body || body.length > 1024) return res.status(400).json({ error: 'Message text is required (up to 1024 characters)' });
  const n = varCount(body);
  if (n && examples.filter(x => String(x).trim()).length < n) return res.status(400).json({ error: `Give an example value for each of the ${n} variables` });
  const components = [{ type: 'BODY', text: body, ...(n ? { example: { body_text: [examples.slice(0, n).map(String)] } } : {}) }];
  if (footer) components.push({ type: 'FOOTER', text: String(footer).slice(0, 60) });
  const btns = buttons.map(b => String(b).trim()).filter(Boolean).slice(0, 3);
  if (btns.length) components.push({ type: 'BUTTONS', buttons: btns.map(t => ({ type: 'QUICK_REPLY', text: t.slice(0, 25) })) });
  try {
    const cat = String(category).toUpperCase();
    const r = await wa.createTemplate({ name, language, category: cat, components });
    res.json((await query(
      `INSERT INTO templates(name,language,body,category,status,meta_id,var_count,footer,buttons) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (name) DO UPDATE SET language=EXCLUDED.language, body=EXCLUDED.body, category=EXCLUDED.category, status=EXCLUDED.status,
         meta_id=EXCLUDED.meta_id, var_count=EXCLUDED.var_count, footer=EXCLUDED.footer, buttons=EXCLUDED.buttons, rejected_reason=NULL RETURNING *`,
      [name, language, body, cat.toLowerCase(), r.status || 'PENDING', r.id, n, footer || null, JSON.stringify(btns)])).rows[0]);
  } catch (e) { res.status(502).json({ error: e.message }); }
}));
router.post('/templates/sync', mgr, wrap(async (req, res) => {
  try {
    const list = await wa.listTemplates();
    for (const t of list) {
      const body = (t.components || []).find(c => c.type === 'BODY')?.text || '';
      await query(
        `INSERT INTO templates(name,language,body,category,status,meta_id,rejected_reason,var_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (name) DO UPDATE SET language=EXCLUDED.language, body=EXCLUDED.body, category=EXCLUDED.category, status=EXCLUDED.status,
           meta_id=EXCLUDED.meta_id, rejected_reason=EXCLUDED.rejected_reason, var_count=EXCLUDED.var_count`,
        [t.name, t.language, body, String(t.category || 'utility').toLowerCase(), t.status, t.id, t.rejected_reason || null, varCount(body)]);
    }
    res.json({ synced: list.length });
  } catch (e) { res.status(502).json({ error: e.message }); }
}));
router.delete('/templates/:id', mgr, wrap(async (req, res) => { await query(`DELETE FROM templates WHERE id=$1 AND status='local'`, [req.params.id]); res.json({ ok: true }); }));

// ---- Contacts ----
router.get('/contacts', mgr, wrap(async (req, res) => {
  const w = ['TRUE'], p = [];
  if (req.query.q) { p.push(`%${req.query.q}%`); w.push(`(ct.name ILIKE $${p.length} OR ct.wa_id ILIKE $${p.length})`); }
  if (req.query.list) { p.push(req.query.list); w.push(`ct.list_name=$${p.length}`); }
  const rows = (await query(
    `SELECT ct.id, ct.wa_id, ct.name, ct.source, ct.list_name, ct.opted_out, c.status AS chat_status, u.name AS agent
       FROM contacts ct LEFT JOIN conversations c ON c.contact_id=ct.id LEFT JOIN users u ON u.id=c.assigned_to
      WHERE ${w.join(' AND ')} ORDER BY ct.id DESC LIMIT 200`, p)).rows;
  res.json({ rows, total: (await query('SELECT COUNT(*)::int AS n FROM contacts')).rows[0].n });
}));
router.get('/contacts/lists', mgr, wrap(async (req, res) =>
  res.json((await query(`SELECT list_name, COUNT(*)::int AS n FROM contacts WHERE list_name IS NOT NULL GROUP BY 1 ORDER BY 1`)).rows)));
router.patch('/contacts/:id', mgr, wrap(async (req, res) => { await query('UPDATE contacts SET opted_out=$2 WHERE id=$1', [req.params.id, !!req.body.opted_out]); res.json({ ok: true }); }));
router.post('/contacts/import', mgr, wrap(async (req, res) => {
  const { list_name, country = '92', consent, rows = [] } = req.body;
  if (!consent) return res.status(400).json({ error: 'Please confirm these people agreed to receive WhatsApp messages from you' });
  if (!String(list_name || '').trim()) return res.status(400).json({ error: 'Give the list a name' });
  const cc = String(country).replace(/\D/g, '') || '92', seen = new Map(); let bad = 0;
  for (const r of rows.slice(0, 20000)) {
    let d = String(r.phone || '').replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = cc + d.slice(1);
    if (d.length < 8 || d.length > 15) { bad++; continue; }
    if (!seen.has(d)) seen.set(d, String(r.name || '').trim().slice(0, 60) || null);
  }
  if (!seen.size) return res.status(400).json({ error: 'No valid phone numbers found' });
  const out = await query(
    `INSERT INTO contacts(wa_id,name,source,list_name,opt_in_source) SELECT x.w, x.n, 'import', $3, $4 FROM unnest($1::text[], $2::text[]) AS x(w, n)
     ON CONFLICT (wa_id) DO UPDATE SET list_name=EXCLUDED.list_name, name=COALESCE(contacts.name, EXCLUDED.name) RETURNING (xmax = 0) AS inserted`,
    [[...seen.keys()], [...seen.values()], String(list_name).trim().slice(0, 60), `import by ${req.user.name}`]);
  const added = out.rows.filter(r => r.inserted).length;
  res.json({ added, updated: out.rows.length - added, skipped: bad });
}));

// ---- Broadcasts ----
router.post('/broadcasts/preview', mgr, wrap(async (req, res) => {
  const rows = await audience(req.body.segment);
  res.json({ count: rows.length, sample: rows.slice(0, 5).map(r => r.name || '+' + r.wa_id) });
}));
router.get('/broadcasts', mgr, wrap(async (req, res) => res.json((await query(
  `SELECT b.id, b.name, b.template_name, b.status, b.scheduled_at, b.finished_at, COUNT(r.id)::int AS total,
          COUNT(*) FILTER (WHERE r.status NOT IN ('queued','skipped','failed'))::int AS sent,
          COUNT(*) FILTER (WHERE r.status IN ('delivered','read'))::int AS delivered,
          COUNT(*) FILTER (WHERE r.status='read')::int AS read,
          COUNT(*) FILTER (WHERE r.status='failed')::int AS failed,
          COUNT(*) FILTER (WHERE r.status='queued')::int AS queued,
          COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id
                                          WHERE c.contact_id=r.contact_id AND m.direction='in' AND m.created_at > r.sent_at))::int AS replied
     FROM broadcasts b LEFT JOIN broadcast_recipients r ON r.broadcast_id=b.id GROUP BY b.id ORDER BY b.id DESC LIMIT 50`)).rows)));
router.post('/broadcasts', mgr, wrap(async (req, res) => {
  const { name, template_name, var_map = [], segment = {}, scheduled_at, consent } = req.body;
  if (!consent) return res.status(400).json({ error: 'Please confirm everyone in this audience agreed to receive these messages' });
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Give the broadcast a name' });
  const t = (await query('SELECT * FROM templates WHERE name=$1', [template_name])).rows[0];
  if (!t) return res.status(404).json({ error: 'Template not found' });
  if (t.status !== 'APPROVED' && !DRY()) return res.status(409).json({ error: 'Meta has not approved this template yet' });
  const vm = Array.isArray(var_map) ? var_map.slice(0, t.var_count) : [];
  if (vm.length < t.var_count || vm.some(m => m.type === 'text' && !String(m.value || '').trim())) return res.status(400).json({ error: `Fill in all ${t.var_count} template variables` });
  const people = await audience(segment);
  if (!people.length) return res.status(400).json({ error: 'No contacts match this audience' });
  const when = scheduled_at && new Date(scheduled_at) > new Date() ? new Date(scheduled_at) : new Date();
  const b = (await query(
    `INSERT INTO broadcasts(name,template_name,language,segment,var_map,scheduled_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [String(name).trim().slice(0, 80), t.name, t.language, JSON.stringify(segment), JSON.stringify(vm), when, req.user.id])).rows[0];
  await query(
    `INSERT INTO broadcast_recipients(broadcast_id,contact_id,wa_id,params) SELECT $1, x.id, x.w, x.p::jsonb FROM unnest($2::int[], $3::text[], $4::text[]) AS x(id, w, p)`,
    [b.id, people.map(p => p.id), people.map(p => p.wa_id), people.map(p => JSON.stringify(paramsFor(vm, p)))]);
  res.json({ id: b.id, recipients: people.length });
}));
router.post('/broadcasts/:id/cancel', mgr, wrap(async (req, res) => {
  await query(`UPDATE broadcasts SET status='cancelled', finished_at=now() WHERE id=$1 AND status IN ('scheduled','sending')`, [req.params.id]);
  await query(`UPDATE broadcast_recipients SET status='skipped' WHERE broadcast_id=$1 AND status='queued'`, [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
