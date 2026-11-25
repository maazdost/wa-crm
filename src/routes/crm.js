// Audience (people grouped by tag) and Pipeline (a board with one column per stage).
// Both read the same contacts and tags as the Contacts page. A pipeline stage is a tag:
// everyone who has the tag is in that stage, and moving a card swaps the tag.
const express = require('express');
const { query } = require('../db');
const { required } = require('../auth');
const tenant = require('../tenant');
const settings = require('../settings');
const C = () => tenant.cid(); // the signed-in person's company; every query below is limited to it
const router = express.Router();
const mgr = required('admin', 'manager');
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });

// One row per person with the ids of all their tags (put on the contact or on the chat). Ignored numbers are left out.
const PEOPLE = `SELECT ct.id, ct.wa_id, COALESCE(NULLIF(ct.profile_name,''), NULLIF(ct.name,'')) AS name, ct.created_at,
    c.id AS conversation_id, c.last_message_at, c.unread_count, c.assigned_to, u.name AS agent,
    ARRAY(SELECT label_id FROM contact_labels WHERE contact_id=ct.id UNION SELECT label_id FROM conversation_labels WHERE conversation_id=c.id) AS tags
  FROM contacts ct LEFT JOIN conversations c ON c.contact_id=ct.id LEFT JOIN users u ON u.id=c.assigned_to
  WHERE ct.company_id=$1 AND NOT ct.is_personal`;
const LAST = `(SELECT COALESCE(NULLIF(m.body,''), '[' || m.type || ']') FROM messages m WHERE m.conversation_id=b.conversation_id ORDER BY m.id DESC LIMIT 1) AS last_text`;
const SORTS = { recent: 'b.last_message_at DESC NULLS LAST, b.id DESC', name: 'lower(b.name) NULLS LAST, b.id', new: 'b.id DESC' };
// The search box, the agent filter and the tag filter, shared by both pages.
function filters(qs, p) {
  const w = [];
  if (qs.q) { p.push(`%${String(qs.q).replace(/^\+/, '')}%`); w.push(`(b.name ILIKE $${p.length} OR b.wa_id ILIKE $${p.length})`); }
  if (Number(qs.agent)) { p.push(Number(qs.agent)); w.push(`b.assigned_to=$${p.length}`); }
  if (Number(qs.has)) { p.push(Number(qs.has)); w.push(`$${p.length} = ANY(b.tags)`); }
  return w;
}
const labels = async () => (await query('SELECT id, name, color FROM labels WHERE company_id=$1 ORDER BY name', [C()])).rows;

/* ---------- Audience ---------- */
// tag: a tag id, "none" for people without a tag, or empty for everyone.
router.get('/contacts/audience', mgr, wrap(async (req, res) => {
  const p = [C()], w = filters(req.query, p), where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const sort = SORTS[req.query.sort] || SORTS.recent, per = 8;
  const stats = (await query(`WITH b AS (${PEOPLE}) SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE cardinality(tags)=0)::int AS untagged,
    COUNT(*) FILTER (WHERE cardinality(tags)>1)::int AS multi, COUNT(*) FILTER (WHERE conversation_id IS NOT NULL)::int AS chats FROM b`, [C()])).rows[0];
  const all = await labels();
  const counts = (await query(`WITH b AS (${PEOPLE}) SELECT t.tag, COUNT(*)::int AS n FROM b
    CROSS JOIN LATERAL unnest(CASE WHEN cardinality(b.tags)=0 THEN ARRAY[0] ELSE b.tags END) AS t(tag) ${where} GROUP BY t.tag`, p)).rows;
  const people = (await query(`WITH b AS (${PEOPLE}) SELECT z.*, ${LAST.replace(/b\./g, 'z.')} FROM (
      SELECT b.*, t.tag, row_number() OVER (PARTITION BY t.tag ORDER BY ${sort}) AS rn FROM b
      CROSS JOIN LATERAL unnest(CASE WHEN cardinality(b.tags)=0 THEN ARRAY[0] ELSE b.tags END) AS t(tag) ${where}) z WHERE z.rn <= ${per} ORDER BY z.tag, z.rn`, p)).rows;
  const want = req.query.tag === 'none' ? [0] : Number(req.query.tag) ? [Number(req.query.tag)] : null;
  const groups = [...all.map(l => ({ ...l })), { id: 0, name: '', color: '#94a3b8' }].filter(g => !want || want.includes(g.id))
    .map(g => ({ ...g, count: (counts.find(c => c.tag === g.id) || {}).n || 0, people: people.filter(x => x.tag === g.id) })).filter(g => g.count);
  res.json({ stats: { ...stats, tags: all.length }, groups, per });
}));
// More people of one group: tag is a tag id, or 0 for people without a tag.
router.get('/contacts/audience/people', mgr, wrap(async (req, res) => {
  const p = [C()], w = filters(req.query, p), tag = Number(req.query.tag) || 0;
  if (tag) { p.push(tag); w.push(`$${p.length} = ANY(b.tags)`); } else w.push('cardinality(b.tags)=0');
  const off = Math.max(0, Number(req.query.offset) || 0);
  res.json({ rows: (await query(`WITH b AS (${PEOPLE}) SELECT b.*, ${LAST} FROM b WHERE ${w.join(' AND ')} ORDER BY ${SORTS[req.query.sort] || SORTS.recent} LIMIT 30 OFFSET ${off}`, p)).rows });
}));

/* ---------- Pipeline ---------- */
const STAGES_SQL = 'SELECT s.id, s.label_id, s.position, l.name, l.color FROM pipeline_stages s JOIN labels l ON l.id=s.label_id WHERE s.company_id=$1 ORDER BY s.position, s.id';
const START = [['New Lead', '#3b82f6'], ['Contacted', '#8b5cf6'], ['Interested', '#f59e0b'], ['Follow-up', '#ec4899']];
const plain = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); // "new-lead", "New Lead" and "#new-lead" count as the same tag
async function tagFor(name, color) {
  const have = (await labels()).find(l => plain(l.name) === plain(name));
  if (have) { // a tag that still has the plain starting colour takes the colour of the stage
    if (have.color === '#0e5a4a' && color !== have.color) await query('UPDATE labels SET color=$3 WHERE id=$1 AND company_id=$2', [have.id, C(), color]);
    return have.id;
  }
  return (await query('INSERT INTO labels(company_id,name,color) VALUES($1,$2,$3) ON CONFLICT (company_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [C(), name, color])).rows[0].id;
}
// The first time a company opens the Pipeline it gets four starting stages. After that the stages are theirs to change.
async function stages() {
  let rows = (await query(STAGES_SQL, [C()])).rows;
  if (rows.length || (await settings.get('pipeline')).started) return rows;
  await settings.set('pipeline', { started: true });
  for (const [i, [name, color]] of START.entries())
    await query('INSERT INTO pipeline_stages(company_id,label_id,position) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [C(), await tagFor(name, color), i]);
  return (await query(STAGES_SQL, [C()])).rows;
}
const CARD_LIMIT = 20;
async function cards(qs, stageLabel, stageLabels, offset = 0) {
  const p = [C()], w = filters(qs, p);
  if (stageLabel) { p.push(stageLabel); w.push(`$${p.length} = ANY(b.tags)`); } else { p.push(stageLabels); w.push(`NOT (b.tags && $${p.length}::int[])`); }
  const where = w.join(' AND ');
  const rows = (await query(`WITH b AS (${PEOPLE}) SELECT b.*, ${LAST} FROM b WHERE ${where} ORDER BY ${SORTS.recent} LIMIT ${CARD_LIMIT} OFFSET ${Math.max(0, Number(offset) || 0)}`, p)).rows;
  const count = (await query(`WITH b AS (${PEOPLE}) SELECT COUNT(*)::int AS n FROM b WHERE ${where}`, p)).rows[0].n;
  return { rows, count };
}
router.get('/contacts/pipeline', mgr, wrap(async (req, res) => {
  const st = await stages(), ids = st.map(s => s.label_id), out = [];
  for (const s of st) { const c = await cards(req.query, s.label_id, ids); out.push({ ...s, count: c.count, cards: c.rows }); }
  const free = await cards(req.query, 0, ids);
  const total = (await query(`SELECT COUNT(*)::int AS n FROM contacts WHERE company_id=$1 AND NOT is_personal`, [C()])).rows[0].n;
  const agents = (await query(`SELECT id, name FROM users WHERE company_id=$1 AND is_active ORDER BY name`, [C()])).rows;
  res.json({ stages: out, unassigned: { count: free.count, cards: free.rows }, total, agents, tags: await labels(), per: CARD_LIMIT });
}));
// More cards of one column: stage is a stage id, or 0 for people who are in no stage.
router.get('/contacts/pipeline/cards', mgr, wrap(async (req, res) => {
  const st = await stages(), s = st.find(x => x.id === Number(req.query.stage));
  if (Number(req.query.stage) && !s) return res.status(404).json({ error: 'Stage not found' });
  res.json(await cards(req.query, s ? s.label_id : 0, st.map(x => x.label_id), req.query.offset));
}));
router.post('/contacts/pipeline/stages', mgr, wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim().replace(/^#/, '').slice(0, 30), color = /^#[0-9a-fA-F]{6}$/.test((req.body || {}).color) ? req.body.color : '#0e5a4a';
  if (!name) return res.status(400).json({ error: 'Give the stage a name' });
  const st = await stages();
  if (st.length >= 12) return res.status(400).json({ error: 'You can have up to 12 stages' });
  const label = await tagFor(name, color);
  if (st.some(s => s.label_id === label)) return res.status(409).json({ error: 'A stage with this name already exists' });
  const s = (await query('INSERT INTO pipeline_stages(company_id,label_id,position) VALUES($1,$2,$3) RETURNING id', [C(), label, (st.length ? Math.max(...st.map(x => x.position)) : -1) + 1])).rows[0];
  res.json({ id: s.id });
}));
// Rename, recolour, or move one place left (-1) or right (1). The name and colour are those of the tag.
router.patch('/contacts/pipeline/stages/:id', mgr, wrap(async (req, res) => {
  const st = await stages(), i = st.findIndex(s => s.id === Number(req.params.id)), b = req.body || {};
  if (i < 0) return res.status(404).json({ error: 'Stage not found' });
  if ('name' in b) {
    const name = String(b.name || '').trim().replace(/^#/, '').slice(0, 30);
    if (!name) return res.status(400).json({ error: 'Give the stage a name' });
    if ((await labels()).some(l => l.id !== st[i].label_id && l.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'A tag with this name already exists' });
    await query('UPDATE labels SET name=$3 WHERE id=$1 AND company_id=$2', [st[i].label_id, C(), name]);
  }
  if (/^#[0-9a-fA-F]{6}$/.test(b.color || '')) await query('UPDATE labels SET color=$3 WHERE id=$1 AND company_id=$2', [st[i].label_id, C(), b.color]);
  const j = i + (Number(b.move) || 0);
  if (Number(b.move) && j >= 0 && j < st.length) {
    const order = st.map(s => s.id); order.splice(j, 0, order.splice(i, 1)[0]);
    for (const [pos, id] of order.entries()) await query('UPDATE pipeline_stages SET position=$3 WHERE id=$1 AND company_id=$2', [id, C(), pos]);
  }
  res.json({ ok: true });
}));
// Removing a stage takes the column away. The tag and the people who have it stay.
router.delete('/contacts/pipeline/stages/:id', mgr, wrap(async (req, res) => {
  await stages(); // marks the pipeline as started, so the starting stages do not come back after the last one is removed
  const gone = (await query('DELETE FROM pipeline_stages WHERE id=$1 AND company_id=$2 RETURNING id', [Number(req.params.id) || 0, C()])).rows[0];
  gone ? res.json({ ok: true }) : res.status(404).json({ error: 'Stage not found' });
}));
// Move a person: takes the tag of the stage they leave (from) and gives the tag of the stage they enter (to). 0 means no stage.
router.post('/contacts/pipeline/move', mgr, wrap(async (req, res) => {
  const b = req.body || {}, st = await stages(), from = st.find(s => s.id === Number(b.from)), to = st.find(s => s.id === Number(b.to));
  if ((Number(b.from) && !from) || (Number(b.to) && !to)) return res.status(404).json({ error: 'Stage not found' });
  const ct = (await query('SELECT ct.id, c.id AS conv FROM contacts ct LEFT JOIN conversations c ON c.contact_id=ct.id WHERE ct.id=$1 AND ct.company_id=$2', [Number(b.contact_id) || 0, C()])).rows[0];
  if (!ct) return res.status(404).json({ error: 'Contact not found' });
  if (from && (!to || to.id !== from.id)) {
    await query('DELETE FROM contact_labels WHERE contact_id=$1 AND label_id=$2', [ct.id, from.label_id]);
    if (ct.conv) await query('DELETE FROM conversation_labels WHERE conversation_id=$1 AND label_id=$2', [ct.conv, from.label_id]);
  }
  if (to) {
    await query('INSERT INTO contact_labels(contact_id,label_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [ct.id, to.label_id]);
    if (ct.conv) await query('INSERT INTO conversation_labels(conversation_id,label_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [ct.conv, to.label_id]);
  }
  res.json({ ok: true });
}));
module.exports = router;
