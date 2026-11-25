// Demo Classes page: the free demo classes, who booked a seat, Came / Didn't come, and the settings.
// Everyone in the team can see the seat lists and mark them; managers change the settings and class links.
const express = require('express');
const { query } = require('../db');
const { required } = require('../auth');
const settings = require('../settings');
const demo = require('../demo');
const tenant = require('../tenant');
const C = () => tenant.cid();
const router = express.Router();
const mgr = required('admin', 'manager');
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });
const str = (x, n) => String(x == null ? '' : x).trim().slice(0, n);
const isDay = (d) => /^\d{4}-\d\d-\d\d$/.test(String(d || ''));
const isTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
const STATUSES = ['booked', 'came', 'missed', 'joined', 'cancelled'];

const LIST = `SELECT b.id, to_char(b.day,'YYYY-MM-DD') AS day, b.place, b.status, b.conversation_id, b.contact_id, b.created_at, b.morning_at, b.hour_at, b.remind_error, b.after_sent,
    COALESCE(NULLIF(ct.name,''), NULLIF(ct.profile_name,''), '+' || ct.wa_id) AS name, ct.wa_id, c.assigned_to, u.name AS agent, bu.name AS booked_by_name
  FROM demo_bookings b JOIN contacts ct ON ct.id=b.contact_id LEFT JOIN conversations c ON c.id=b.conversation_id
  LEFT JOIN users u ON u.id=c.assigned_to LEFT JOIN users bu ON bu.id=b.booked_by`;

router.get('/demo', required(), wrap(async (req, res) => {
  const s = await settings.get('demo'), today = demo.localNow(s.tz).date;
  const from = isDay(req.query.from) ? req.query.from : today;
  const [bookings, stats] = await Promise.all([
    query(`${LIST} WHERE b.company_id=$1 AND b.day >= $2 AND b.status <> 'moved' ORDER BY b.day, b.place, b.created_at LIMIT 1000`, [C(), from]),
    query(`SELECT COUNT(*) FILTER (WHERE status='booked' AND day >= $2)::int AS upcoming,
        COUNT(*) FILTER (WHERE status IN ('came','joined') AND day >= $2::date - 30)::int AS came,
        COUNT(*) FILTER (WHERE status='missed' AND day >= $2::date - 30)::int AS missed,
        COUNT(*) FILTER (WHERE status='joined' AND day >= $2::date - 30)::int AS joined,
        COUNT(*) FILTER (WHERE status='booked' AND day < $2)::int AS unmarked
      FROM demo_bookings WHERE company_id=$1 AND status <> 'moved'`, [C(), today])
  ]);
  // past classes that nobody marked yet are shown too, so they can be marked
  const unmarked = (await query(`${LIST} WHERE b.company_id=$1 AND b.day < $2 AND b.day >= $2::date - 14 AND b.status='booked' ORDER BY b.day, b.place`, [C(), from])).rows;
  res.json({ settings: s, today, sessions: await demo.upcoming(s, { limit: 12 }), bookings: [...unmarked, ...bookings.rows], stats: stats.rows[0] });
}));

// The seat of one chat (for the contact panel in Live Chat)
router.get('/demo/chat/:id', required(), wrap(async (req, res) => {
  const s = await settings.get('demo');
  const b = (await query(`${LIST} WHERE b.company_id=$1 AND b.conversation_id=$2 AND b.status <> 'moved' ORDER BY b.day DESC, b.id DESC LIMIT 1`, [C(), Number(req.params.id) || 0])).rows[0] || null;
  res.json({ enabled: !!s.enabled, booking: b, sessions: s.enabled ? await demo.upcoming(s, { limit: 12 }) : [], places: s.places || [] });
}));

const loadConv = async (req, res, id) => {
  const c = (await query('SELECT * FROM conversations WHERE id=$1 AND company_id=$2', [Number(id) || 0, C()])).rows[0];
  if (!c) { res.status(404).json({ error: 'Chat not found' }); return null; }
  if (req.user.role === 'agent' && c.assigned_to !== req.user.id) { res.status(403).json({ error: 'This chat is not yours' }); return null; }
  return c;
};

router.post('/demo/bookings', required(), wrap(async (req, res) => {
  const b = req.body || {};
  const conv = await loadConv(req, res, b.conversation_id); if (!conv) return;
  if (!isDay(b.day)) return res.status(400).json({ error: 'Choose a class' });
  const out = await demo.book({ conv, day: b.day, place: str(b.place, 40), by: req.user.id });
  if (out.error) return res.status(400).json({ error: out.error });
  let sent = null;
  if (b.notify !== false && !out.already) {
    const s = await settings.get('demo'), contact = (await query('SELECT * FROM contacts WHERE id=$1', [conv.contact_id])).rows[0];
    const text = demo.fillBooked(contact, out.booking, s);
    sent = await demo.sendText(conv, contact, text, s, out.booking).catch(e => ({ sent: false, why: e.message }));
  }
  require('../realtime').toConversation(conv, 'conversation:updated', { conversationId: conv.id });
  res.json({ ...out, sent });
}));

router.patch('/demo/bookings/:id', required(), wrap(async (req, res) => {
  const status = String((req.body || {}).status || '');
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  const b = (await query('SELECT * FROM demo_bookings WHERE id=$1 AND company_id=$2', [Number(req.params.id) || 0, C()])).rows[0];
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (req.user.role === 'agent') {
    const c = b.conversation_id && (await query('SELECT assigned_to FROM conversations WHERE id=$1', [b.conversation_id])).rows[0];
    if (!c || c.assigned_to !== req.user.id) return res.status(403).json({ error: 'This client is not yours' });
  }
  res.json(await demo.mark({ ...b, day: demo.isoDay(b.day) }, status));
}));

// ---- Settings (managers) ----
router.put('/demo-settings', mgr, wrap(async (req, res) => {
  const b = req.body || {}, cur = await settings.get('demo');
  const keys = new Set();
  const places = (Array.isArray(b.places) ? b.places : cur.places).slice(0, 3).map((p, i) => {
    let key = str(p.key, 20).toLowerCase().replace(/[^a-z0-9_]/g, '') || 'place' + (i + 1);
    while (keys.has(key)) key += '_'; keys.add(key);
    return { key, name: str(p.name, 40) || 'Place ' + (i + 1), time: isTime(p.time) ? p.time : '19:00', seats: Math.min(10000, Math.max(0, Math.round(Number(p.seats)) || 0)), info: str(p.info, 300) };
  });
  if (!places.length) return res.status(400).json({ error: 'Add at least one place' });
  const days = Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))] : cur.days;
  if (!days.length) return res.status(400).json({ error: 'Choose at least one day' });
  const team = str(b.team, 40);
  if (team && !(await query('SELECT 1 FROM departments WHERE key=$1 AND company_id=$2', [team, C()])).rows[0]) return res.status(400).json({ error: 'Unknown department' });
  const words = (Array.isArray(b.words) ? b.words : String(b.words == null ? cur.words.join(',') : b.words).split(',')).map(w => str(w, 40).toLowerCase()).filter(Boolean).slice(0, 20);
  const v = { ...cur, enabled: 'enabled' in b ? !!b.enabled : cur.enabled, places, days, team, words,
    morning: isTime(b.morning) ? b.morning : cur.morning, before: Math.min(600, Math.max(10, Math.round(Number(b.before)) || cur.before || 60)),
    template: str(b.template == null ? cur.template : b.template, 512) };
  for (const f of ['ask', 'pick_day', 'booked', 'full', 'none', 'remind_morning', 'remind_hour', 'came', 'missed']) if (typeof b[f] === 'string') v[f] = b[f].trim().slice(0, 1000);
  await settings.set('demo', v);
  res.json(v);
}));
router.put('/demo-settings/link', mgr, wrap(async (req, res) => {
  const b = req.body || {};
  if (!isDay(b.day)) return res.status(400).json({ error: 'Choose a class' });
  const link = str(b.link, 500);
  if (link && !/^https?:\/\/\S+$/i.test(link)) return res.status(400).json({ error: 'The link must start with https://' });
  await query(`INSERT INTO demo_sessions(company_id, day, place, link) VALUES($1,$2,$3,$4) ON CONFLICT (company_id, day, place) DO UPDATE SET link=EXCLUDED.link`, [C(), b.day, str(b.place, 40), link]);
  res.json({ ok: true });
}));

module.exports = router;
