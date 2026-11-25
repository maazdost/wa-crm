// Daily summary page (Settings > Daily summary): switch on, time, numbers, preview, Send now, and the template for Meta.
const express = require('express');
const { query } = require('../db');
const { required } = require('../auth');
const settings = require('../settings');
const summary = require('../summary');
const wa = require('../whatsapp');
const tenant = require('../tenant');
const C = () => tenant.cid();
const router = express.Router();
const mgr = required('admin', 'manager');
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });

const page = async () => {
  const s = await settings.get('summary'), tz = s.tz || 'Asia/Karachi', day = summary.localNow(tz).date;
  const st = await summary.stats(day, tz), co = (await query('SELECT name FROM companies WHERE id=$1', [C()])).rows[0] || {};
  const t = s.template ? (await query('SELECT name, status, rejected_reason, body FROM templates WHERE company_id=$1 AND name=$2', [C(), s.template])).rows[0] || null : null;
  return { settings: s, today: day, preview: summary.text(st, co.name), template: t, template_text: summary.TEMPLATE.body };
};
router.get('/summary-settings', mgr, wrap(async (req, res) => res.json(await page())));

router.put('/summary-settings', mgr, wrap(async (req, res) => {
  const b = req.body || {}, cur = await settings.get('summary');
  const v = { ...cur };
  if ('enabled' in b) v.enabled = !!b.enabled;
  if ('push' in b) v.push = !!b.push;
  if ('time' in b) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time))) return res.status(400).json({ error: 'Choose a time like 22:00' }); v.time = b.time; }
  if ('numbers' in b) {
    const raw = (Array.isArray(b.numbers) ? b.numbers : String(b.numbers || '').split(/[,\n;]/)).map(x => String(x).trim()).filter(Boolean);
    const ok = raw.map(summary.cleanPhone), bad = raw.filter((_, i) => !ok[i]);
    if (bad.length) return res.status(400).json({ error: `This number does not look right: ${bad[0]}. Write it with the country code, like 923001234567.` });
    v.numbers = [...new Set(ok)].slice(0, 10);
  }
  if (v.enabled && !v.numbers.length && !v.push) return res.status(400).json({ error: 'Add at least one WhatsApp number' });
  // Switched on after today's time has passed: start tomorrow, so it does not go out the moment you save.
  if (v.enabled && !cur.enabled) { const now = summary.localNow(v.tz); if (now.mins >= Number(v.time.slice(0, 2)) * 60 + Number(v.time.slice(3))) v.last_day = now.date; }
  await settings.set('summary', v);
  res.json(await page());
}));

router.post('/summary-settings/send', mgr, wrap(async (req, res) => {
  const s = await settings.get('summary');
  if (!(s.numbers || []).length) return res.status(400).json({ error: 'Add at least one WhatsApp number first' });
  const out = await summary.send({ s });
  res.json({ results: out.results, text: out.text });
}));

// Sends the summary template to Meta for approval (needed to reach a number that has not written in the last 24 hours).
router.post('/summary-settings/template', mgr, wrap(async (req, res) => {
  const T = summary.TEMPLATE, n = T.examples.length;
  try {
    const r = await wa.createTemplate({ name: T.name, language: T.language, category: T.category, components: [{ type: 'BODY', text: T.body, example: { body_text: [T.examples] } }] });
    const row = (await query(`INSERT INTO templates(company_id,name,language,body,category,status,meta_id,var_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (company_id,name) DO UPDATE SET language=EXCLUDED.language, body=EXCLUDED.body, category=EXCLUDED.category, status=EXCLUDED.status,
        meta_id=EXCLUDED.meta_id, var_count=EXCLUDED.var_count, rejected_reason=NULL RETURNING name, status, body`,
      [C(), T.name, T.language, T.body, T.category.toLowerCase(), r.status || 'PENDING', r.id, n])).rows[0];
    const s = await settings.get('summary'); if (s.template !== T.name) await settings.set('summary', { ...s, template: T.name });
    res.json({ template: row });
  } catch (e) { res.status(502).json({ error: e.message }); }
}));

module.exports = router;
