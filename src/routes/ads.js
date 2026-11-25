// Ad routing page: the rules that send ad clients straight to a department, and the ads clients came from.
const express = require('express');
const { query } = require('../db');
const { required } = require('../auth');
const adroute = require('../adroute');
const tenant = require('../tenant');
const C = () => tenant.cid(); // the signed-in person's company; every query below is limited to it
const router = express.Router();
const mgr = required('admin', 'manager');
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });
const str = (x, n) => String(x == null ? '' : x).trim().slice(0, n);

async function clean(b) {
  const seen = new Set();
  const keywords = (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(','))
    .map(k => str(k, 200).replace(/\s+/g, ' ')).filter(k => k && !seen.has(k.toLowerCase()) && seen.add(k.toLowerCase())).slice(0, 30);
  if (!keywords.length) return { error: 'Add at least one word from the ad, for example classes' };
  const team = str(b.team, 40);
  if (!team || !(await query('SELECT 1 FROM departments WHERE key=$1 AND company_id=$2', [team, C()])).rows[0]) return { error: 'Choose a department' };
  return { name: str(b.name, 80) || keywords[0], keywords, team, message: str(b.message, 1000) };
}

router.get('/ad-rules', mgr, wrap(async (req, res) => {
  const rules = (await query('SELECT * FROM ad_rules WHERE company_id=$1 ORDER BY id', [C()])).rows;
  // Each ad clients came from, with how many leads it brought and how many got a reply from a person
  const ads = (await query(`SELECT ct.ad_headline AS headline, ct.ad_source_url AS url, ct.ad_source_id AS id, ct.channel, ct.ad_source_type AS type,
        COUNT(*)::int AS leads, MAX(ct.ad_clicked_at) AS last_at,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.sender_type='agent'))::int AS answered
      FROM contacts ct LEFT JOIN conversations c ON c.contact_id=ct.id
     WHERE ct.company_id=$1 AND (ct.ad_headline IS NOT NULL OR ct.ad_source_url IS NOT NULL OR ct.ad_source_id IS NOT NULL)
     GROUP BY 1,2,3,4,5 ORDER BY MAX(ct.ad_clicked_at) DESC NULLS LAST LIMIT 100`, [C()])).rows;
  res.json({ rules, ads: ads.map(a => ({ ...a, rule_id: (adroute.ruleFor(rules, a) || {}).id || null })) });
}));
router.post('/ad-rules', mgr, wrap(async (req, res) => {
  const v = await clean(req.body); if (v.error) return res.status(400).json(v);
  if ((await query('SELECT COUNT(*)::int AS n FROM ad_rules WHERE company_id=$1', [C()])).rows[0].n >= 100) return res.status(400).json({ error: 'You can have up to 100 ad rules' });
  res.json((await query('INSERT INTO ad_rules(company_id,name,keywords,team,message) VALUES($1,$2,$3,$4,$5) RETURNING *', [C(), v.name, JSON.stringify(v.keywords), v.team, v.message])).rows[0]);
}));
router.patch('/ad-rules/:id', mgr, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (Object.keys(req.body).length === 1 && 'active' in req.body) { // the on/off switch
    const r = (await query('UPDATE ad_rules SET active=$3 WHERE id=$1 AND company_id=$2 RETURNING *', [id, C(), !!req.body.active])).rows[0];
    return r ? res.json(r) : res.status(404).json({ error: 'not found' });
  }
  const v = await clean(req.body); if (v.error) return res.status(400).json(v);
  const r = (await query('UPDATE ad_rules SET name=$3, keywords=$4, team=$5, message=$6 WHERE id=$1 AND company_id=$2 RETURNING *', [id, C(), v.name, JSON.stringify(v.keywords), v.team, v.message])).rows[0];
  r ? res.json(r) : res.status(404).json({ error: 'not found' });
}));
router.delete('/ad-rules/:id', mgr, wrap(async (req, res) => {
  await query('DELETE FROM ad_rules WHERE id=$1 AND company_id=$2', [Number(req.params.id) || 0, C()]); res.json({ ok: true });
}));

module.exports = router;
