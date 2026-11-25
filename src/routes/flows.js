// Chatbots page: the flows of a company, their on/off switch and the list of clients who went through them.
const express = require('express');
const { query } = require('../db');
const { required } = require('../auth');
const flows = require('../flows');
const mediaStore = require('../media');
const tenant = require('../tenant');
const C = () => tenant.cid(); // the signed-in person's company; every query below is limited to it
const router = express.Router();
const mgr = required('admin', 'manager');
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });
const str = (x, n) => String(x == null ? '' : x).trim().slice(0, n);
const KIND_NAME = { image: 'a photo (JPG or PNG)', video: 'a video (MP4)' };

// Checks a flow sent from the page and returns it in the shape that is stored.
async function clean(b) {
  const name = str(b.name, 80);
  if (!name) return { error: 'Give this chatbot a name' };
  const trigger = b.trigger === 'welcome' ? 'welcome' : 'keyword', match_type = b.match_type === 'exact' ? 'exact' : 'contains';
  const seen = new Set(); // the same keyword twice (in any letter case) is kept once
  const keywords = trigger === 'welcome' ? [] : (Array.isArray(b.keywords) ? b.keywords : []).map(k => str(k, 300).replace(/\s+/g, ' ')).filter(k => k && !seen.has(k.toLowerCase()) && seen.add(k.toLowerCase())).slice(0, 30);
  if (trigger === 'keyword' && !keywords.length) return { error: 'Add at least one keyword that starts this chatbot' };
  const raw = Array.isArray(b.steps) ? b.steps : [];
  if (!raw.length) return { error: 'Add at least one step' };
  if (raw.length > 30) return { error: 'A chatbot can have up to 30 steps' };
  const ids = raw.map(s => str(s && s.id, 12));
  if (ids.some(id => !/^[a-z0-9]{1,12}$/.test(id)) || new Set(ids).size !== ids.length) return { error: 'The steps are mixed up. Refresh the page and try again.' };
  const goes = (v) => { v = str(v, 12); return v === '' || v === 'end' || ids.includes(v) ? v : null; };
  const mids = [...new Set(raw.map(s => Number(s.media_id)).filter(Boolean))], pids = [...new Set(raw.map(s => Number(s.product_id)).filter(Boolean))];
  const files = mids.length ? (await query('SELECT id, mime FROM media_library WHERE company_id=$1 AND id = ANY($2::int[])', [C(), mids])).rows : [];
  const products = pids.length ? (await query('SELECT id FROM products WHERE company_id=$1 AND id = ANY($2::int[])', [C(), pids])).rows : [];
  const steps = [];
  for (const [i, s] of raw.entries()) {
    const n = `Step ${i + 1}`, type = flows.TYPES.includes(s.type) ? s.type : null;
    if (!type) return { error: `${n}: unknown kind of step` };
    const next = goes(s.next); if (next === null) return { error: `${n}: the step it goes to no longer exists` };
    const step = { id: ids[i], type }, text = str(s.text, 1000);
    if (type === 'message') {
      step.kind = flows.KINDS.includes(s.kind) ? s.kind : 'text';
      if (step.kind === 'product') {
        if (!products.some(p => p.id === Number(s.product_id))) return { error: `${n}: choose a product from your catalog` };
        step.product_id = Number(s.product_id);
      } else if (step.kind === 'text') { if (!text) return { error: `${n}: type the message` }; step.text = text; }
      else {
        const f = files.find(x => x.id === Number(s.media_id));
        if (!f) return { error: `${n}: choose a file from the Media Library` };
        if (step.kind !== 'file' && mediaStore.kindOf(f.mime) !== step.kind) return { error: `${n}: the chosen file is not ${KIND_NAME[step.kind]}. Choose another file or use the File type.` };
        step.media_id = f.id; step.text = text;
      }
      step.next = next;
    } else if (type === 'buttons') {
      if (!text) return { error: `${n}: type the question` };
      const btns = (Array.isArray(s.buttons) ? s.buttons : []).map(x => ({ title: str(x && x.title, 20), next: goes(x && x.next) })).filter(x => x.title).slice(0, 3);
      if (!btns.length) return { error: `${n}: add at least one button` };
      if (btns.some(x => x.next === null)) return { error: `${n}: a button goes to a step that no longer exists` };
      if (new Set(btns.map(x => x.title.toLowerCase())).size !== btns.length) return { error: `${n}: two buttons have the same name` };
      step.text = text; step.buttons = btns;
    } else if (type === 'question') {
      if (!text) return { error: `${n}: type the question` };
      step.text = text; step.save = s.save === 'name' ? 'name' : 'other'; step.label = step.save === 'name' ? 'Name' : str(s.label, 30);
      if (!step.label) return { error: `${n}: say what this answer is, for example City` };
      step.next = next;
    } else if (type === 'action') {
      step.tag_id = Number(s.tag_id) || null; step.assign_to = Number(s.assign_to) || null; step.team = str(s.team, 40) || null;
      if (!step.tag_id && !step.assign_to && !step.team) return { error: `${n}: choose a tag, a department or an agent` };
      if (step.tag_id && !(await query('SELECT 1 FROM labels WHERE id=$1 AND company_id=$2', [step.tag_id, C()])).rows[0]) return { error: `${n}: the chosen tag no longer exists` };
      if (step.assign_to && !(await query('SELECT 1 FROM users WHERE id=$1 AND company_id=$2 AND is_active', [step.assign_to, C()])).rows[0]) return { error: `${n}: the chosen agent is not active` };
      if (step.team && !(await query('SELECT 1 FROM departments WHERE key=$1 AND company_id=$2', [step.team, C()])).rows[0]) return { error: `${n}: the chosen department no longer exists` };
      step.next = next;
    } else step.text = text; // handover: the goodbye text is optional
    steps.push(step);
  }
  return { name, trigger, match_type, keywords, steps, retry_text: str(b.retry_text, 300) };
}
const COLS = 'id, name, trigger, match_type, keywords, steps, retry_text, active, started_count, finished_count, last_started_at, created_at';
const vals = (v) => [v.name, v.trigger, v.match_type, JSON.stringify(v.keywords), JSON.stringify(v.steps), v.retry_text];
// Only one welcome flow can be on: switching one on switches the others off.
const onlyWelcome = (id) => query(`UPDATE bot_flows SET active=FALSE WHERE company_id=$1 AND trigger='welcome' AND id<>$2 AND active
  AND EXISTS (SELECT 1 FROM bot_flows WHERE id=$2 AND active AND trigger='welcome')`, [C(), id]);

router.get('/flows', mgr, wrap(async (req, res) => {
  const list = (await query(`SELECT ${COLS} FROM bot_flows WHERE company_id=$1 ORDER BY (trigger='welcome') DESC, id DESC`, [C()])).rows;
  const runs = (await query(`SELECT r.id, r.flow_id, f.name AS flow_name, r.conversation_id, r.client, r.answers, r.result, r.started_at, r.finished_at
    FROM bot_flow_runs r JOIN bot_flows f ON f.id=r.flow_id WHERE r.company_id=$1 ORDER BY r.id DESC LIMIT 30`, [C()])).rows;
  res.json({ flows: list, runs, retry_text: flows.RETRY });
}));
router.post('/flows', mgr, wrap(async (req, res) => {
  const v = await clean(req.body); if (v.error) return res.status(400).json(v);
  const n = (await query('SELECT COUNT(*)::int AS n FROM bot_flows WHERE company_id=$1', [C()])).rows[0].n;
  if (n >= 50) return res.status(400).json({ error: 'You can have up to 50 chatbots. Delete the ones you no longer use.' });
  // A new flow is saved switched off, so nothing changes for clients until it is switched on.
  res.json((await query(`INSERT INTO bot_flows(company_id,name,trigger,match_type,keywords,steps,retry_text,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLS}`, [C(), ...vals(v), req.user.id])).rows[0]);
}));
router.patch('/flows/:id', mgr, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (Object.keys(req.body).length === 1 && 'active' in req.body) { // the on/off switch
    const r = (await query('UPDATE bot_flows SET active=$3, updated_at=now() WHERE id=$1 AND company_id=$2 RETURNING id, active, trigger', [id, C(), !!req.body.active])).rows[0];
    if (!r) return res.status(404).json({ error: 'not found' });
    await onlyWelcome(id);
    return res.json(r);
  }
  const v = await clean(req.body); if (v.error) return res.status(400).json(v);
  const r = (await query(`UPDATE bot_flows SET name=$3, trigger=$4, match_type=$5, keywords=$6, steps=$7, retry_text=$8, updated_at=now() WHERE id=$1 AND company_id=$2 RETURNING ${COLS}`, [id, C(), ...vals(v)])).rows[0];
  if (!r) return res.status(404).json({ error: 'not found' });
  await onlyWelcome(id);
  res.json(r);
}));
router.delete('/flows/:id', mgr, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  // New clients who were in the middle of this flow start again with whatever welcomes clients now.
  await query(`UPDATE conversations SET bot_step='new' WHERE company_id=$2 AND flow_id=$1 AND status='bot' AND bot_step='flow'`, [id, C()]);
  await query('DELETE FROM bot_flows WHERE id=$1 AND company_id=$2', [id, C()]);
  res.json({ ok: true });
}));

module.exports = router;
