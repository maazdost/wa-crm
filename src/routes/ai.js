// AI Agent page: the company's notes and settings, how much of the plan is used, a "Try it" chat and what the AI answered lately.
const express = require('express');
const { query } = require('../db');
const { required } = require('../auth');
const ai = require('../ai');
const plan = require('../plan');
const tenant = require('../tenant');
const C = () => tenant.cid(); // the signed-in person's company; every query below is limited to it
const router = express.Router();
const mgr = required('admin', 'manager');
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });

const view = (c) => ({ enabled: !!c.enabled, name: c.name, notes: c.notes, tone: c.tone, language: c.language, returning: !!c.returning, max_replies: c.max_replies });

router.get('/ai', mgr, wrap(async (req, res) => {
  const cfg = await ai.config(), p = await plan.current(), u = await plan.usage();
  const stats = (await query(`SELECT COUNT(*) FILTER (WHERE result='answered')::int AS answered, COUNT(*) FILTER (WHERE result='handover')::int AS handed,
      COUNT(*) FILTER (WHERE result IN ('error','limit'))::int AS failed, COUNT(DISTINCT conversation_id)::int AS chats
    FROM ai_replies WHERE company_id=$1 AND created_at >= date_trunc('month', now())`, [C()])).rows[0];
  const recent = (await query(`SELECT r.id, r.question, r.answer, r.result, r.created_at, r.conversation_id, COALESCE(ct.name, ct.profile_name, '+' || ct.wa_id) AS client
    FROM ai_replies r LEFT JOIN conversations c ON c.id=r.conversation_id LEFT JOIN contacts ct ON ct.id=c.contact_id
    WHERE r.company_id=$1 ORDER BY r.id DESC LIMIT 30`, [C()])).rows;
  const welcome = (await query(`SELECT name FROM bot_flows WHERE company_id=$1 AND trigger='welcome' AND active LIMIT 1`, [C()])).rows[0];
  res.json({ settings: view(cfg), ready: ai.ready(), used: u.ai_replies, limit: p.limits.ai_replies, plan: p.name, stats, recent, welcome_flow: welcome ? welcome.name : null, notes_max: ai.NOTES_MAX });
}));

router.put('/ai', mgr, wrap(async (req, res) => {
  const b = req.body || {};
  if (b.enabled && !ai.ready()) return res.status(400).json({ error: 'The AI is not connected on the server yet. Ask your provider to set GEMINI_API_KEY.' });
  const out = await ai.save(b);
  if (out.error) return res.status(400).json({ error: out.error });
  res.json({ settings: view(out) });
}));

// "Try it": the page sends the test chat so far and the notes as typed (saved or not). Nothing is sent to WhatsApp and nothing counts against the plan.
const tries = new Map(); // company id -> times of the last tries, so a stuck page cannot run up a bill
router.post('/ai/try', mgr, wrap(async (req, res) => {
  if (!ai.ready()) return res.status(400).json({ error: 'The AI is not connected on the server yet. Ask your provider to set GEMINI_API_KEY.' });
  const now = Date.now(), mine = (tries.get(C()) || []).filter(t => now - t < 3600000);
  if (mine.length >= 60) return res.status(429).json({ error: 'That is a lot of tests in one hour. Try again a little later.' });
  mine.push(now); tries.set(C(), mine);
  const b = req.body || {}, saved = await ai.config();
  const cfg = { ...saved, name: String(b.name || saved.name).slice(0, 40), notes: String(b.notes == null ? saved.notes : b.notes).slice(0, ai.NOTES_MAX), tone: ai.TONES[b.tone] ? b.tone : saved.tone, language: ai.LANGS[b.language] ? b.language : saved.language };
  if (cfg.notes.trim().length < 30) return res.status(400).json({ error: 'Write a few lines about your business first. The AI answers only from these notes.' });
  const turns = (Array.isArray(b.turns) ? b.turns : []).slice(-20).map(t => ({ role: t && t.role === 'assistant' ? 'assistant' : 'user', text: String((t && t.text) || '').slice(0, 2000) }));
  const company = (await query('SELECT name FROM companies WHERE id=$1', [C()])).rows[0]?.name;
  let out;
  try { out = await ai.ask(cfg, company, turns); } catch (e) { console.error('ai try:', ai.problem(e)); return res.status(502).json({ error: ai.problem(e) }); }
  if (out.error) return res.status(502).json({ error: 'The AI gave no usable answer. In a real chat the client would go to an agent.' });
  res.json({ reply: out.reply, handover: out.handover });
}));

module.exports = router;
