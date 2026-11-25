// Facebook and Instagram Automation: the rules, the "Try it" test run and the recent activity list.
const express = require('express');
const { query } = require('../db');
const { required } = require('../auth');
const social = require('../social');
const tenant = require('../tenant');
const C = () => tenant.cid(); // the signed-in person's company; every query below is limited to it
const router = express.Router();
const mgr = required('admin', 'manager');
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });
const platform = (req, res) => social.PLATFORMS.includes(req.params.platform) ? req.params.platform : (res.status(404).json({ error: 'not found' }), null);

// Checks a rule sent from the page and returns it in the shape that is stored.
const clean = (b) => {
  const str = (x, n) => String(x == null ? '' : x).trim().slice(0, n);
  const name = str(b.name, 80);
  if (!name) return { error: 'Give this rule a name' };
  const trigger = social.TRIGGERS.includes(b.trigger) ? b.trigger : 'comment';
  const match_type = ['any', 'contains', 'exact'].includes(b.match_type) ? b.match_type : 'contains';
  const seen = new Set(); // the same keyword twice (in any letter case) is kept once
  const keywords = match_type === 'any' ? [] : (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(',')).map(k => str(k, 100).replace(/\s+/g, ' ')).filter(k => k && !seen.has(k.toLowerCase()) && seen.add(k.toLowerCase())).slice(0, 30);
  if (match_type !== 'any' && !keywords.length) return { error: 'Add at least one keyword' };
  const reply_text = str(b.reply_text, 1000), private_text = trigger === 'comment' ? str(b.private_text, 1000) : '';
  if (trigger === 'dm' && !reply_text) return { error: 'Type the reply to send' };
  if (trigger === 'comment' && !reply_text && !private_text) return { error: 'Type a public reply, a private message, or both' };
  return { name, trigger, match_type, keywords, reply_text, private_text };
};

router.get('/social/:platform', mgr, wrap(async (req, res) => {
  const pf = platform(req, res); if (!pf) return;
  const rules = (await query('SELECT id, name, trigger, match_type, keywords, reply_text, private_text, active, sent_count, last_sent_at, created_at FROM social_rules WHERE company_id=$1 AND platform=$2 ORDER BY id DESC', [C(), pf])).rows;
  const log = (await query('SELECT id, rule_name, trigger, from_name, text, reply, private_reply, status, created_at FROM social_log WHERE company_id=$1 AND platform=$2 ORDER BY id DESC LIMIT 30', [C(), pf])).rows;
  // connected stays false until a page can be linked, which Meta allows only after business verification
  res.json({ platform: pf, connected: false, rules, log });
}));
router.post('/social/:platform/rules', mgr, wrap(async (req, res) => {
  const pf = platform(req, res); if (!pf) return;
  const v = clean(req.body); if (v.error) return res.status(400).json(v);
  const n = (await query('SELECT COUNT(*)::int AS n FROM social_rules WHERE company_id=$1 AND platform=$2', [C(), pf])).rows[0].n;
  if (n >= 100) return res.status(400).json({ error: 'You can have up to 100 rules. Delete the ones you no longer use.' });
  res.json((await query('INSERT INTO social_rules(company_id,platform,name,trigger,match_type,keywords,reply_text,private_text,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [C(), pf, v.name, v.trigger, v.match_type, JSON.stringify(v.keywords), v.reply_text, v.private_text, req.user.id])).rows[0]);
}));
router.patch('/social/rules/:id', mgr, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (Object.keys(req.body).length === 1 && 'active' in req.body) { // the on/off switch
    const r = (await query('UPDATE social_rules SET active=$3 WHERE id=$1 AND company_id=$2 RETURNING id, active', [id, C(), !!req.body.active])).rows[0];
    return r ? res.json(r) : res.status(404).json({ error: 'not found' });
  }
  const v = clean(req.body); if (v.error) return res.status(400).json(v);
  const r = (await query('UPDATE social_rules SET name=$3, trigger=$4, match_type=$5, keywords=$6, reply_text=$7, private_text=$8 WHERE id=$1 AND company_id=$2 RETURNING *',
    [id, C(), v.name, v.trigger, v.match_type, JSON.stringify(v.keywords), v.reply_text, v.private_text])).rows[0];
  r ? res.json(r) : res.status(404).json({ error: 'not found' });
}));
router.delete('/social/rules/:id', mgr, wrap(async (req, res) => {
  await query('DELETE FROM social_rules WHERE id=$1 AND company_id=$2', [Number(req.params.id) || 0, C()]);
  res.json({ ok: true });
}));
// "Try it": shows which rule would answer a comment or message, and with what. Nothing is sent.
router.post('/social/:platform/test', mgr, wrap(async (req, res) => {
  const pf = platform(req, res); if (!pf) return;
  const text = String(req.body.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'Type a comment or message to try' });
  res.json(await social.handle({ platform: pf, trigger: social.TRIGGERS.includes(req.body.trigger) ? req.body.trigger : 'comment', text, name: String(req.body.name || '').trim().slice(0, 120) || 'Ayesha Khan', test: true }));
}));

module.exports = router;
