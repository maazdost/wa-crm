const express = require('express');
const { query } = require('../db');
const { required } = require('../auth');
const wa = require('../whatsapp');
const { audience, paramsFor } = require('../broadcast');
const { markPersonal } = require('../personal');
const settings = require('../settings');
const numbers = require('../numbers');
const tenant = require('../tenant');
const source = require('../source');
const C = () => tenant.cid(); // the signed-in person's company; every query below is limited to it
const envToken = () => C() === 1 ? process.env.WA_ACCESS_TOKEN : null; // the server's own token belongs to company 1 only
const router = express.Router();
const mgr = required('admin', 'manager');
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });
const varCount = (b) => Math.max(0, ...[...String(b).matchAll(/\{\{(\d+)\}\}/g)].map(m => +m[1]));
const DRY = () => process.env.WA_DRY_RUN === 'true';

// ---- WhatsApp numbers (add, check, switch default, remove) ----
const admin = required('admin');
const sanitizeId = (x) => String(x || '').replace(/\D/g, '');

router.get('/whatsapp/numbers', mgr, wrap(async (req, res) => res.json(await numbers.list())));

router.post('/whatsapp/numbers', admin, wrap(async (req, res) => {
  const label = String(req.body.label || '').trim().slice(0, 40), pid = sanitizeId(req.body.phone_number_id);
  const token = String(req.body.access_token || '').trim(), waba = sanitizeId(req.body.waba_id);
  if (!label) return res.status(400).json({ error: 'Give the number a name, for example "Sales" or "Support"' });
  if (pid.length < 8) return res.status(400).json({ error: 'Paste the Phone number ID from Meta (a long number, not the phone number itself)' });
  if (await numbers.byPhoneId(pid)) return res.status(409).json({ error: 'This number is already added' });
  const over = await require('../plan').check('numbers'); if (over) return res.status(402).json({ error: over });
  let info = {};
  if (!DRY()) {
    const tk = token || envToken();
    if (!tk) return res.status(400).json({ error: 'Paste an access token for this number' });
    try { info = await wa.graphWith(tk, `${pid}?fields=display_phone_number,verified_name`); }
    catch (e) { return res.status(400).json({ error: 'Meta did not accept this Phone number ID and token: ' + e.message }); }
  }
  const row = await numbers.add({ label, phone_number_id: pid, token, waba_id: waba, display_phone: info.display_phone_number, verified_name: info.verified_name, make_default: !!req.body.make_default });
  let subscribed = null; // best effort: make sure Meta sends this account's messages to our webhook
  if (waba && !DRY()) {
    try { await fetch(`${process.env.GRAPH_BASE || 'https://graph.facebook.com'}/${process.env.WA_API_VERSION || 'v21.0'}/${waba}/subscribed_apps`, { method: 'POST', headers: { Authorization: `Bearer ${token || envToken()}` } }).then(r => { subscribed = r.ok; }); }
    catch { subscribed = false; }
  }
  res.json({ ...row, subscribed });
}));

router.patch('/whatsapp/numbers/:id', admin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await numbers.get(id);
  if (!cur) return res.status(404).json({ error: 'Number not found' });
  const { label, access_token, clear_token, waba_id, make_default, calls_enabled } = req.body;
  if (label !== undefined) { if (!String(label).trim()) return res.status(400).json({ error: 'The name cannot be empty' }); await query('UPDATE wa_numbers SET label=$2 WHERE id=$1', [id, String(label).trim().slice(0, 40)]); }
  if (waba_id !== undefined) await query('UPDATE wa_numbers SET waba_id=$2 WHERE id=$1', [id, sanitizeId(waba_id) || null]);
  if (clear_token) await query('UPDATE wa_numbers SET access_token=NULL WHERE id=$1', [id]);
  else if (access_token && String(access_token).trim()) await query('UPDATE wa_numbers SET access_token=$2 WHERE id=$1', [id, numbers.encrypt(String(access_token).trim())]);
  if (make_default) await numbers.makeDefault(id);
  if (calls_enabled !== undefined) { // switch calling on/off in Meta first, then remember it here
    const want = !!calls_enabled;
    try { await wa.forNumber(id).setCalling(want); } catch (e) { return res.status(502).json({ error: 'Meta did not change calling: ' + e.message }); }
    await query('UPDATE wa_numbers SET calls_enabled=$2 WHERE id=$1', [id, want]);
  }
  res.json({ ok: true });
}));

router.delete('/whatsapp/numbers/:id', admin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const n = await numbers.get(id);
  if (!n) return res.status(404).json({ error: 'Number not found' });
  if (n.is_default) return res.status(409).json({ error: 'This is the default number. Make another number the default first.' });
  const used = (await query('SELECT (SELECT COUNT(*) FROM conversations WHERE wa_number_id=$1)::int AS c, (SELECT COUNT(*) FROM broadcasts WHERE wa_number_id=$1)::int AS b', [id])).rows[0];
  if (used.c || used.b) return res.status(409).json({ error: `${used.c} chat(s) and ${used.b} broadcast(s) use this number. Keep it here so they can still send and receive.` });
  await query('DELETE FROM wa_numbers WHERE id=$1 AND company_id=$2', [id, C()]);
  res.json({ ok: true });
}));

// ---- WhatsApp connection check (one result per number) ----
async function checkNumber(n) {
  const out = { id: n.id, label: n.label, phone_number_id: n.phone_number_id, is_default: n.is_default, calls_enabled: n.calls_enabled, waba_id: n.waba_id || (C() === 1 && process.env.WA_WABA_ID) || null };
  let w; try { w = wa.forNumber(n.id); } catch (e) { return { ...out, token_ok: false, token_error: e.message }; }
  try { out.number = await w.graph(`${n.phone_number_id}?fields=display_phone_number,verified_name,quality_rating`); out.token_ok = true;
        if (out.number.display_phone_number && out.number.display_phone_number !== n.display_phone) await query('UPDATE wa_numbers SET display_phone=$2, verified_name=$3 WHERE id=$1', [n.id, out.number.display_phone_number, out.number.verified_name || null]); }
  catch (e) { out.token_ok = false; out.token_error = e.message; }
  if (!out.waba_id && n.is_default) out.waba_id = (await settings.get('wa')).waba_id || null;
  if (out.waba_id) {
    try { out.waba_has_number = (await w.graph(`${out.waba_id}/phone_numbers?fields=id`)).data.some(x => x.id === n.phone_number_id); } catch (e) { out.waba_error = e.message; }
    try { out.subscribed = ((await w.graph(`${out.waba_id}/subscribed_apps`)).data || []).length > 0; } catch (e) { /* shown as unknown */ }
  }
  return out;
}
router.get('/whatsapp/status', mgr, wrap(async (req, res) => {
  const out = { dry_run: DRY(), signature_check: !!process.env.WA_APP_SECRET, numbers: [] };
  const list = await numbers.list();
  if (DRY()) { out.numbers = list; return res.json(out); }
  out.numbers = await Promise.all(list.map(checkNumber));
  res.json(out);
}));
router.post('/whatsapp/detect', mgr, wrap(async (req, res) => {
  const ids = (req.body.ids || []).map(sanitizeId).filter(Boolean).slice(0, 10), results = [];
  const n = req.body.number_id ? await numbers.get(Number(req.body.number_id)) : await numbers.getDefault();
  const phone = n ? n.phone_number_id : (C() === 1 ? process.env.WA_PHONE_NUMBER_ID : null), w = wa.forNumber(n && n.id);
  for (const id of ids) {
    try { const d = (await w.graph(`${id}/phone_numbers?fields=id,display_phone_number`)).data || []; results.push({ id, numbers: d.map(x => x.display_phone_number), has_ours: d.some(x => x.id === phone) }); }
    catch (e) { results.push({ id, error: e.message }); }
  }
  const hit = results.filter(r => r.has_ours);
  if (hit.length === 1) { if (n) await query('UPDATE wa_numbers SET waba_id=$2 WHERE id=$1', [n.id, hit[0].id]); if (!n || n.is_default) await settings.set('wa', { waba_id: hit[0].id }); }
  res.json({ results, saved: hit.length === 1 ? hit[0].id : null });
}));

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
      `INSERT INTO templates(company_id,name,language,body,category,status,meta_id,var_count,footer,buttons) VALUES($10,$1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (company_id,name) DO UPDATE SET language=EXCLUDED.language, body=EXCLUDED.body, category=EXCLUDED.category, status=EXCLUDED.status,
         meta_id=EXCLUDED.meta_id, var_count=EXCLUDED.var_count, footer=EXCLUDED.footer, buttons=EXCLUDED.buttons, rejected_reason=NULL RETURNING *`,
      [name, language, body, cat.toLowerCase(), r.status || 'PENDING', r.id, n, footer || null, JSON.stringify(btns), C()])).rows[0]);
  } catch (e) { res.status(502).json({ error: e.message }); }
}));
router.post('/templates/sync', mgr, wrap(async (req, res) => {
  try {
    const list = await wa.listTemplates();
    for (const t of list) {
      const body = (t.components || []).find(c => c.type === 'BODY')?.text || '';
      await query(
        `INSERT INTO templates(company_id,name,language,body,category,status,meta_id,rejected_reason,var_count) VALUES($9,$1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (company_id,name) DO UPDATE SET language=EXCLUDED.language, body=EXCLUDED.body, category=EXCLUDED.category, status=EXCLUDED.status,
           meta_id=EXCLUDED.meta_id, rejected_reason=EXCLUDED.rejected_reason, var_count=EXCLUDED.var_count`,
        [t.name, t.language, body, String(t.category || 'utility').toLowerCase(), t.status, t.id, t.rejected_reason || null, varCount(body), C()]);
    }
    res.json({ synced: list.length });
  } catch (e) { res.status(502).json({ error: e.message }); }
}));
router.delete('/templates/:id', mgr, wrap(async (req, res) => { await query(`DELETE FROM templates WHERE id=$1 AND company_id=$2 AND status='local'`, [req.params.id, C()]); res.json({ ok: true }); }));

// ---- Contacts ----
const normPhone = (raw, cc) => { let d = String(raw || '').replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = cc + d.slice(1); return d.length < 8 || d.length > 15 ? null : d; };
const cleanEmail = (e) => { e = String(e || '').trim().slice(0, 120); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null; };
// A contact's tags are the ones put on the contact here plus the ones agents put on the chat.
const TAGS_SQL = `COALESCE((SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color) ORDER BY l.name) FROM labels l
  WHERE l.id IN (SELECT label_id FROM contact_labels WHERE contact_id=ct.id UNION SELECT label_id FROM conversation_labels WHERE conversation_id=c.id)), '[]') AS tags`;
const CONTACT_COLS = `ct.id, ct.wa_id, COALESCE(ct.profile_name, ct.name) AS name, ct.email, COALESCE(ct.source,'organic') AS source, ct.list_name, ct.opted_out, ct.is_personal, ct.created_at, ct.fields,
  ct.channel, ct.ad_source_url, ct.ad_source_type, ct.ad_headline, ct.ad_clicked_at,
  c.id AS conversation_id, c.status AS chat_status, GREATEST(c.last_customer_message_at, ct.last_seen_at) AS last_seen, u.name AS agent, ${TAGS_SQL}`;
const CONTACT_FROM = 'FROM contacts ct LEFT JOIN conversations c ON c.contact_id=ct.id LEFT JOIN users u ON u.id=c.assigned_to';
// The search box and the filters of the Contacts page, shared by the list and the export.
function contactFilter(qs) {
  const w = ['ct.company_id=$1'], p = [C()];
  const add = (sql, v) => { p.push(v); w.push(sql.replace(/\?/g, '$' + p.length)); };
  if (qs.q) add('(ct.name ILIKE ? OR ct.profile_name ILIKE ? OR ct.wa_id ILIKE ? OR ct.email ILIKE ? OR ct.ad_source_url ILIKE ? OR EXISTS (SELECT 1 FROM jsonb_each_text(ct.fields) f WHERE f.value ILIKE ?))', `%${String(qs.q).replace(/^\+/, '')}%`);
  if (qs.list) add('ct.list_name=?', String(qs.list));
  // Source: a channel (Facebook, Instagram, WhatsApp...), "ad" for everyone who came through an ad, or how they were added (imported, by hand)
  const src = String(qs.source || '');
  if (src === 'ad') w.push("(ct.source='ad' OR ct.ad_source_url IS NOT NULL)");
  else if (src.startsWith('ch:')) add('ct.channel=?', src.slice(3));
  else if (src === 'unknown') w.push('ct.channel IS NULL');
  else if (src) add("COALESCE(ct.source,'organic')=?", src);
  // Added on and last seen: within the last N days, or (last seen) more than 30 days ago or never
  const days = n => Math.min(3650, Math.max(1, Number(n) || 0));
  if (Number(qs.added)) add("ct.created_at > now() - make_interval(days => ?)", days(qs.added));
  const seen = "GREATEST(c.last_customer_message_at, ct.last_seen_at)";
  if (qs.seen === 'never') w.push(`${seen} IS NULL`);
  else if (qs.seen === 'old') w.push(`${seen} <= now() - interval '30 days'`);
  else if (Number(qs.seen)) add(`${seen} > now() - make_interval(days => ?)`, days(qs.seen));
  if (Number(qs.tag)) add('(EXISTS (SELECT 1 FROM contact_labels x WHERE x.contact_id=ct.id AND x.label_id=?) OR EXISTS (SELECT 1 FROM conversation_labels y WHERE y.conversation_id=c.id AND y.label_id=?))', Number(qs.tag));
  if (qs.opt === 'in') w.push('NOT ct.opted_out'); else if (qs.opt === 'out') w.push('ct.opted_out');
  if (qs.status === 'active') w.push('NOT ct.is_personal'); else if (qs.status === 'ignored') w.push('ct.is_personal');
  return { where: w.join(' AND '), p };
}
// Puts exactly these tags on a contact, and on the chat of that contact when there is one, so both places agree.
async function setTags(contactId, ids) {
  const want = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean))].slice(0, 50);
  const ok = want.length ? (await query('SELECT id FROM labels WHERE company_id=$1 AND id = ANY($2::int[])', [C(), want])).rows.map(r => r.id) : [];
  await query('DELETE FROM contact_labels WHERE contact_id=$1', [contactId]);
  if (ok.length) await query('INSERT INTO contact_labels(contact_id,label_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING', [contactId, ok]);
  const conv = (await query('SELECT id FROM conversations WHERE contact_id=$1', [contactId])).rows[0];
  if (conv) {
    await query('DELETE FROM conversation_labels WHERE conversation_id=$1', [conv.id]);
    if (ok.length) await query('INSERT INTO conversation_labels(conversation_id,label_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING', [conv.id, ok]);
  }
}
// ---- Custom fields: extra things a company wants to keep about each contact (city, budget, birthday) ----
const FIELD_KINDS = ['text', 'number', 'date', 'list'];
const fieldList = async () => (await query('SELECT id, name, kind, options, in_list FROM contact_fields WHERE company_id=$1 ORDER BY position, id', [C()])).rows;
// Keeps only answers that fit the field: a number for a number field, a real date for a date field, one of the choices for a list.
function fitField(f, raw) {
  const v = String(raw == null ? '' : raw).trim().slice(0, 200);
  if (!v) return '';
  if (f.kind === 'number') { const n = v.replace(/,/g, ''); return /^-?\d+(\.\d+)?$/.test(n) ? n : null; }
  if (f.kind === 'date') {
    let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/), y, mo, d;
    if (m) [y, mo, d] = [+m[1], +m[2], +m[3]]; else if ((m = v.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/))) [d, mo, y] = [+m[1], +m[2], +m[3]]; else return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  }
  if (f.kind === 'list') { const o = (f.options || []).find(x => String(x).toLowerCase() === v.toLowerCase()); return o == null ? null : String(o); }
  return v;
}
// Turns { fieldId: answer } from the page into what is saved. bad lists the names of fields whose answer did not fit.
function fitFields(defs, given) {
  const set = {}, drop = [], bad = [];
  for (const f of defs) {
    if (!given || !(f.id in given)) continue;
    const v = fitField(f, given[f.id]);
    if (v === null) bad.push(f.name); else if (v === '') drop.push(String(f.id)); else set[f.id] = v;
  }
  return { set, drop, bad };
}
async function saveFields(contactId, given) {
  if (!given || typeof given !== 'object') return [];
  const { set, drop, bad } = fitFields(await fieldList(), given);
  if (bad.length) return bad;
  await query('UPDATE contacts SET fields = (fields || $2::jsonb) - $3::text[] WHERE id=$1 AND company_id=$4', [contactId, JSON.stringify(set), drop, C()]);
  return [];
}
const fieldBody = (b) => {
  const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 40), kind = FIELD_KINDS.includes(b.kind) ? b.kind : 'text';
  const options = kind === 'list' ? [...new Set((Array.isArray(b.options) ? b.options : String(b.options || '').split(/[\n,]/)).map(o => String(o).trim().slice(0, 40)).filter(Boolean))].slice(0, 30) : [];
  return { name, kind, options, in_list: !!b.in_list };
};
router.get('/contacts/fields', mgr, wrap(async (_req, res) => res.json(await fieldList())));
router.post('/contacts/fields', mgr, wrap(async (req, res) => {
  const f = fieldBody(req.body || {});
  if (!f.name) return res.status(400).json({ error: 'Give the field a name' });
  if (f.kind === 'list' && f.options.length < 2) return res.status(400).json({ error: 'Add at least two choices for a list' });
  const all = await fieldList();
  if (all.length >= 30) return res.status(400).json({ error: 'You can have up to 30 custom fields' });
  if (all.some(x => x.name.toLowerCase() === f.name.toLowerCase())) return res.status(409).json({ error: 'A field with this name already exists' });
  res.json((await query('INSERT INTO contact_fields(company_id,name,kind,options,in_list,position) VALUES($1,$2,$3,$4,$5,$6) RETURNING id, name, kind, options, in_list',
    [C(), f.name, f.kind, JSON.stringify(f.options), f.in_list, all.length])).rows[0]);
}));
// The kind of a field stays as it was made, so answers already saved keep fitting.
router.patch('/contacts/fields/:id', mgr, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0, all = await fieldList(), cur = all.find(x => x.id === id);
  if (!cur) return res.status(404).json({ error: 'Field not found' });
  const b = req.body || {}, f = fieldBody({ name: 'name' in b ? b.name : cur.name, kind: cur.kind, options: 'options' in b ? b.options : cur.options, in_list: 'in_list' in b ? b.in_list : cur.in_list });
  if (!f.name) return res.status(400).json({ error: 'Give the field a name' });
  if (f.kind === 'list' && f.options.length < 2) return res.status(400).json({ error: 'Add at least two choices for a list' });
  if (all.some(x => x.id !== id && x.name.toLowerCase() === f.name.toLowerCase())) return res.status(409).json({ error: 'A field with this name already exists' });
  res.json((await query('UPDATE contact_fields SET name=$3, options=$4, in_list=$5 WHERE id=$1 AND company_id=$2 RETURNING id, name, kind, options, in_list', [id, C(), f.name, JSON.stringify(f.options), f.in_list])).rows[0]);
}));
router.delete('/contacts/fields/:id', mgr, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const gone = (await query('DELETE FROM contact_fields WHERE id=$1 AND company_id=$2 RETURNING id', [id, C()])).rows[0];
  if (!gone) return res.status(404).json({ error: 'Field not found' });
  await query('UPDATE contacts SET fields = fields - $2 WHERE company_id=$1 AND fields ? $2', [C(), String(id)]);
  res.json({ ok: true });
}));

// Deletes contacts of this company with everything that hangs on them: chat, messages, notes, follow-ups and broadcast rows.
async function removeContacts(ids) {
  const own = (await query('SELECT id FROM contacts WHERE company_id=$1 AND id = ANY($2::int[])', [C(), ids])).rows.map(r => r.id);
  if (!own.length) return 0;
  const convs = (await query('SELECT id FROM conversations WHERE contact_id = ANY($1::int[])', [own])).rows.map(r => r.id);
  await query('DELETE FROM drip_enrollments WHERE contact_id = ANY($1::int[])', [own]);
  await query('DELETE FROM broadcast_recipients WHERE contact_id = ANY($1::int[])', [own]);
  if (convs.length) {
    await query('DELETE FROM notes WHERE conversation_id = ANY($1::int[])', [convs]);
    await query('DELETE FROM messages WHERE conversation_id = ANY($1::int[])', [convs]);
    await query('DELETE FROM conversations WHERE id = ANY($1::int[])', [convs]);
  }
  await query('DELETE FROM contacts WHERE company_id=$1 AND id = ANY($2::int[])', [C(), own]);
  return own.length;
}
router.get('/contacts', mgr, wrap(async (req, res) => {
  const { where, p } = contactFilter(req.query);
  const per = Math.min(200, Math.max(10, Number(req.query.per) || 50)), page = Math.max(1, Number(req.query.page) || 1);
  const rows = (await query(`SELECT ${CONTACT_COLS} ${CONTACT_FROM} WHERE ${where} ORDER BY ct.id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`, p)).rows;
  const found = (await query(`SELECT COUNT(*)::int AS n ${CONTACT_FROM} WHERE ${where}`, p)).rows[0].n;
  const stats = (await query(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE c.last_customer_message_at > now() - interval '30 days')::int AS active,
      COUNT(*) FILTER (WHERE ct.source='import')::int AS imported,
      COUNT(*) FILTER (WHERE ct.opted_out OR ct.is_personal)::int AS blocked ${CONTACT_FROM} WHERE ct.company_id=$1`, [C()])).rows[0];
  res.json({ rows, total: stats.total, found, page, per, stats });
}));
// Everything the current search and filters show, for the Excel export (up to 50,000 people).
router.get('/contacts/export', mgr, wrap(async (req, res) => {
  const { where, p } = contactFilter(req.query);
  res.json({ rows: (await query(`SELECT ${CONTACT_COLS} ${CONTACT_FROM} WHERE ${where} ORDER BY ct.id DESC LIMIT 50000`, p)).rows });
}));
router.get('/contacts/lists', mgr, wrap(async (req, res) =>
  res.json((await query(`SELECT list_name, COUNT(*)::int AS n FROM contacts WHERE company_id=$1 AND list_name IS NOT NULL GROUP BY 1 ORDER BY 1`, [C()])).rows)));
router.post('/contacts', mgr, wrap(async (req, res) => {
  const b = req.body || {}, wa = normPhone(b.phone, String(b.country || '92').replace(/\D/g, '') || '92');
  if (!wa) return res.status(400).json({ error: 'Type a valid phone number with the country code, for example 923001234567' });
  if (b.email && !cleanEmail(b.email)) return res.status(400).json({ error: 'This email address does not look right' });
  const name = String(b.name || '').trim().slice(0, 60) || null;
  if (b.ad_source_url && !source.cleanUrl(b.ad_source_url)) return res.status(400).json({ error: 'The ad link does not look right. Paste the full link, starting with https://' });
  if ((await query('SELECT 1 FROM contacts WHERE company_id=$1 AND wa_id=$2', [C(), wa])).rows[0]) return res.status(409).json({ error: 'A contact with this number already exists' });
  const adUrl = source.cleanUrl(b.ad_source_url);
  const c = (await query(`INSERT INTO contacts(company_id,wa_id,name,profile_name,custom_name,email,source,list_name,opt_in_source,channel,ad_source_url) VALUES($1,$2,$3,$3,$4,$5,'manual',$6,$7,$8,$9) RETURNING id`,
    [C(), wa, name, !!name, cleanEmail(b.email), String(b.list_name || '').trim().slice(0, 60) || null, `added by ${req.user.name}`, source.normChannel(b.channel, adUrl), adUrl])).rows[0];
  await setTags(c.id, b.tags);
  const bad = await saveFields(c.id, b.fields);
  res.json({ id: c.id, ...(bad.length ? { warning: 'Not saved, the answer does not fit: ' + bad.join(', ') } : {}) });
}));
router.patch('/contacts/:id', mgr, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0, b = req.body || {};
  if (!(await query('SELECT 1 FROM contacts WHERE id=$1 AND company_id=$2', [id, C()])).rows[0]) return res.status(404).json({ error: 'Contact not found' });
  if ('email' in b && b.email && !cleanEmail(b.email)) return res.status(400).json({ error: 'This email address does not look right' });
  if ('ad_source_url' in b && b.ad_source_url && !source.cleanUrl(b.ad_source_url)) return res.status(400).json({ error: 'The ad link does not look right. Paste the full link, starting with https://' });
  if ('is_personal' in b) { if (b.is_personal) await markPersonal(id); else await query('UPDATE contacts SET is_personal=FALSE WHERE id=$1 AND company_id=$2', [id, C()]); }
  if ('opted_out' in b) await query('UPDATE contacts SET opted_out=$2 WHERE id=$1 AND company_id=$3', [id, !!b.opted_out, C()]);
  if ('name' in b) { // a name typed here stays, even when the person's WhatsApp profile name is different
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Type a name' });
    await query('UPDATE contacts SET name=$2, profile_name=$2, custom_name=TRUE WHERE id=$1 AND company_id=$3', [id, name, C()]);
  }
  if ('email' in b) await query('UPDATE contacts SET email=$2 WHERE id=$1 AND company_id=$3', [id, cleanEmail(b.email), C()]);
  if ('list_name' in b) await query('UPDATE contacts SET list_name=$2 WHERE id=$1 AND company_id=$3', [id, String(b.list_name || '').trim().slice(0, 60) || null, C()]);
  if ('channel' in b) await query('UPDATE contacts SET channel=$2 WHERE id=$1 AND company_id=$3', [id, source.normChannel(b.channel), C()]);
  if ('ad_source_url' in b) await query('UPDATE contacts SET ad_source_url=$2 WHERE id=$1 AND company_id=$3', [id, source.cleanUrl(b.ad_source_url), C()]);
  if ('fields' in b) { const bad = await saveFields(id, b.fields); if (bad.length) return res.status(400).json({ error: 'The answer does not fit: ' + bad.join(', ') }); }
  if ('tags' in b) await setTags(id, b.tags);
  res.json({ ok: true });
}));
router.delete('/contacts/:id', mgr, wrap(async (req, res) => {
  const n = await removeContacts([Number(req.params.id) || 0]);
  n ? res.json({ ok: true }) : res.status(404).json({ error: 'Contact not found' });
}));
router.post('/contacts/delete', mgr, wrap(async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean))].slice(0, 5000);
  if (!ids.length) return res.status(400).json({ error: 'Choose at least one contact' });
  res.json({ deleted: await removeContacts(ids) });
}));
router.post('/contacts/ignore', mgr, wrap(async (req, res) => {
  const cc = String(req.body.country || '92').replace(/\D/g, '') || '92'; let n = 0;
  for (const raw of (req.body.numbers || []).slice(0, 5000)) {
    let d = String(raw).replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = cc + d.slice(1);
    if (d.length < 8 || d.length > 15) continue;
    const c = (await query(`INSERT INTO contacts(company_id,wa_id,source,is_personal) VALUES($2,$1,'personal',TRUE) ON CONFLICT (company_id,wa_id) DO UPDATE SET is_personal=TRUE RETURNING id`, [d, C()])).rows[0];
    await markPersonal(c.id); n++;
  }
  res.json({ ignored: n });
}));
const TAG_COLORS = ['#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#10b981', '#ef4444', '#06b6d4', '#84cc16', '#f97316', '#6366f1', '#14b8a6', '#a855f7', '#eab308', '#0ea5e9', '#f43f5e', '#64748b']; // new tags from a file each get their own colour
router.post('/contacts/import', mgr, wrap(async (req, res) => {
  const { list_name, country = '92', consent, rows = [] } = req.body;
  if (!consent) return res.status(400).json({ error: 'Please confirm these people agreed to receive WhatsApp messages from you' });
  if (!String(list_name || '').trim()) return res.status(400).json({ error: 'Give the list a name' });
  const cc = String(country).replace(/\D/g, '') || '92', seen = new Map(), defs = await fieldList(); let bad = 0;
  for (const r of (Array.isArray(rows) ? rows : []).slice(0, 20000)) {
    const d = normPhone(r && r.phone, cc);
    if (!d) { bad++; continue; }
    const adUrl = source.cleanUrl(r.ad_source_url);
    if (!seen.has(d)) seen.set(d, { name: String(r.name || '').trim().slice(0, 60) || null, email: cleanEmail(r.email), fields: JSON.stringify(fitFields(defs, r.fields).set),
      channel: source.normChannel(r.source, adUrl), ad: adUrl, seen: source.cleanDate(r.last_seen), added: source.cleanDate(r.added_on),
      tags: (Array.isArray(r.tags) ? r.tags : String(r.tags || '').split(/[,;|]/)).map(t => String(t).trim().slice(0, 30)).filter(Boolean).slice(0, 10) });
  }
  if (!seen.size) return res.status(400).json({ error: 'No valid phone numbers found' });
  const vals = [...seen.values()];
  const out = await query(
    `INSERT INTO contacts(company_id,wa_id,name,email,source,list_name,opt_in_source,fields,channel,ad_source_url,last_seen_at,created_at)
     SELECT $5, x.w, x.n, x.e, 'import', $3, $4, x.f::jsonb, x.ch, x.ad, x.ls, COALESCE(x.ao, now())
       FROM unnest($1::text[], $2::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::timestamptz[], $11::timestamptz[]) AS x(w, n, e, f, ch, ad, ls, ao)
     ON CONFLICT (company_id,wa_id) DO UPDATE SET list_name=EXCLUDED.list_name, name=COALESCE(contacts.name, EXCLUDED.name), email=COALESCE(EXCLUDED.email, contacts.email), fields=contacts.fields || EXCLUDED.fields,
       channel=COALESCE(contacts.channel, EXCLUDED.channel), ad_source_url=COALESCE(contacts.ad_source_url, EXCLUDED.ad_source_url),
       last_seen_at=GREATEST(contacts.last_seen_at, EXCLUDED.last_seen_at), created_at=LEAST(contacts.created_at, EXCLUDED.created_at)
     RETURNING id, wa_id, (xmax = 0) AS inserted`,
    [[...seen.keys()], vals.map(v => v.name), String(list_name).trim().slice(0, 60), `import by ${req.user.name}`, C(), vals.map(v => v.email), vals.map(v => v.fields),
     vals.map(v => v.channel), vals.map(v => v.ad), vals.map(v => v.seen), vals.map(v => v.added)]);
  // Tags from the file: a tag that does not exist yet is created (same name in other letter case counts as the same tag).
  const have = new Map((await query('SELECT id, name FROM labels WHERE company_id=$1', [C()])).rows.map(l => [l.name.toLowerCase(), l.id]));
  let made = 0;
  for (const t of new Set(vals.flatMap(v => v.tags))) {
    if (have.has(t.toLowerCase()) || have.size >= 300) continue;
    const l = (await query('INSERT INTO labels(company_id,name,color) VALUES($1,$2,$3) ON CONFLICT (company_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [C(), t, TAG_COLORS[have.size % TAG_COLORS.length]])).rows[0];
    have.set(t.toLowerCase(), l.id); made++;
  }
  const cs = [], ls = [];
  for (const r of out.rows) for (const t of seen.get(r.wa_id).tags) { const id = have.get(t.toLowerCase()); if (id) { cs.push(r.id); ls.push(id); } }
  if (cs.length) await query('INSERT INTO contact_labels(contact_id,label_id) SELECT * FROM unnest($1::int[], $2::int[]) ON CONFLICT DO NOTHING', [cs, ls]);
  const added = out.rows.filter(r => r.inserted).length;
  res.json({ added, updated: out.rows.length - added, skipped: bad, tags_created: made });
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
     FROM broadcasts b LEFT JOIN broadcast_recipients r ON r.broadcast_id=b.id WHERE b.company_id=$1 GROUP BY b.id ORDER BY b.id DESC LIMIT 50`, [C()])).rows)));
router.post('/broadcasts', mgr, wrap(async (req, res) => {
  const { name, template_name, var_map = [], segment = {}, scheduled_at, consent, wa_number_id } = req.body;
  if (!consent) return res.status(400).json({ error: 'Please confirm everyone in this audience agreed to receive these messages' });
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Give the broadcast a name' });
  const t = (await query('SELECT * FROM templates WHERE name=$1 AND company_id=$2', [template_name, C()])).rows[0];
  if (!t) return res.status(404).json({ error: 'Template not found' });
  if (t.status !== 'APPROVED' && !DRY()) return res.status(409).json({ error: 'Meta has not approved this template yet' });
  const vm = Array.isArray(var_map) ? var_map.slice(0, t.var_count) : [];
  if (vm.length < t.var_count || vm.some(m => m.type === 'text' && !String(m.value || '').trim())) return res.status(400).json({ error: `Fill in all ${t.var_count} template variables` });
  let numId = null;
  if (wa_number_id) { numId = Number(wa_number_id); if (!(await numbers.get(numId))) return res.status(400).json({ error: 'That WhatsApp number does not exist' }); }
  const people = await audience(segment);
  if (!people.length) return res.status(400).json({ error: 'No contacts match this audience' });
  const over = await require('../plan').check('broadcast', people.length); if (over) return res.status(402).json({ error: over });
  const when = scheduled_at && new Date(scheduled_at) > new Date() ? new Date(scheduled_at) : new Date();
  const b = (await query(
    `INSERT INTO broadcasts(company_id,name,template_name,language,segment,var_map,scheduled_at,created_by,wa_number_id) VALUES($9,$1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [String(name).trim().slice(0, 80), t.name, t.language, JSON.stringify(segment), JSON.stringify(vm), when, req.user.id, numId, C()])).rows[0];
  await query(
    `INSERT INTO broadcast_recipients(broadcast_id,contact_id,wa_id,params) SELECT $1, x.id, x.w, x.p::jsonb FROM unnest($2::int[], $3::text[], $4::text[]) AS x(id, w, p)`,
    [b.id, people.map(p => p.id), people.map(p => p.wa_id), people.map(p => JSON.stringify(paramsFor(vm, p)))]);
  res.json({ id: b.id, recipients: people.length });
}));
router.post('/broadcasts/:id/cancel', mgr, wrap(async (req, res) => {
  const b = (await query('SELECT id FROM broadcasts WHERE id=$1 AND company_id=$2', [Number(req.params.id) || 0, C()])).rows[0];
  if (!b) return res.status(404).json({ error: 'Broadcast not found' });
  await query(`UPDATE broadcasts SET status='cancelled', finished_at=now() WHERE id=$1 AND status IN ('scheduled','sending')`, [b.id]);
  await query(`UPDATE broadcast_recipients SET status='skipped' WHERE broadcast_id=$1 AND status='queued'`, [b.id]);
  res.json({ ok: true });
}));

// ---- Follow-ups (automatic message sequences) ----
router.get('/drips', mgr, wrap(async (req, res) => res.json((await query(
  `SELECT d.*, COUNT(e.id)::int AS enrolled, COUNT(*) FILTER (WHERE e.status='active')::int AS running,
          COUNT(*) FILTER (WHERE e.status='done')::int AS done, COUNT(*) FILTER (WHERE e.status='stopped')::int AS stopped
     FROM drips d LEFT JOIN drip_enrollments e ON e.drip_id=d.id WHERE d.company_id=$1 GROUP BY d.id ORDER BY d.id DESC`, [C()])).rows)));
router.post('/drips', mgr, wrap(async (req, res) => {
  const { name, stop_on_reply = true, steps = [] } = req.body;
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Give the follow-up a name' });
  if (!Array.isArray(steps) || !steps.length || steps.length > 5) return res.status(400).json({ error: 'Add between 1 and 5 steps' });
  const clean = [];
  for (const s of steps) {
    const t = (await query('SELECT * FROM templates WHERE name=$1 AND company_id=$2', [s.template, C()])).rows[0];
    if (!t) return res.status(400).json({ error: 'Choose a template for every step' });
    if (t.status !== 'APPROVED' && !DRY()) return res.status(409).json({ error: `Meta has not approved "${t.name}" yet` });
    const vm = (s.var_map || []).slice(0, t.var_count);
    if (vm.length < t.var_count || vm.some(x => x.type === 'text' && !String(x.value || '').trim())) return res.status(400).json({ error: `Fill in all ${t.var_count} variables for "${t.name}"` });
    clean.push({ delay_hours: Math.min(Math.max(Number(s.delay_hours) || 0, 0), 720), template: t.name, var_map: vm });
  }
  res.json((await query('INSERT INTO drips(company_id,name,stop_on_reply,steps) VALUES($4,$1,$2,$3) RETURNING *', [String(name).trim().slice(0, 80), !!stop_on_reply, JSON.stringify(clean), C()])).rows[0]);
}));
router.patch('/drips/:id', mgr, wrap(async (req, res) => { await query('UPDATE drips SET active=$2 WHERE id=$1 AND company_id=$3', [req.params.id, !!req.body.active, C()]); res.json({ ok: true }); }));
router.delete('/drips/:id', mgr, wrap(async (req, res) => { await query('DELETE FROM drips WHERE id=$1 AND company_id=$2', [req.params.id, C()]); res.json({ ok: true }); }));

module.exports = router;
