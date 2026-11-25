// Permissions, Activity Log and Notification Preferences.
const express = require('express');
const { query } = require('../db');
const { required } = require('../auth');
const tenant = require('../tenant');
const access = require('../access');
const push = require('../push');
const router = express.Router();
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });
const C = () => tenant.cid();
const TZ = () => process.env.REPORT_TZ || 'Asia/Karachi';
const day = (s) => /^\d{4}-\d\d-\d\d$/.test(String(s || '')) ? s : null;

// ---- Permissions: only the admin decides ----
router.get('/permissions', required('admin'), wrap(async (req, res) => res.json(await access.matrix(C()))));
router.put('/permissions', required('admin'), wrap(async (req, res) => { await access.save(C(), req.body || {}); res.json(await access.matrix(C())); }));

// ---- Activity Log: admins always; managers when the admin allows it (checked in access.js) ----
router.get('/activity-log', required('admin', 'manager'), wrap(async (req, res) => {
  const p = [C(), TZ()], w = ['a.company_id=$1'];
  const from = day(req.query.from), to = day(req.query.to);
  if (from) { p.push(from); w.push(`(a.created_at AT TIME ZONE $2)::date >= $${p.length}::date`); }
  if (to) { p.push(to); w.push(`(a.created_at AT TIME ZONE $2)::date <= $${p.length}::date`); }
  if (Number(req.query.user_id)) { p.push(Number(req.query.user_id)); w.push(`a.user_id=$${p.length}`); }
  if (req.query.area) { p.push(String(req.query.area)); w.push(`a.area=$${p.length}`); }
  if (req.query.q) { p.push('%' + String(req.query.q).slice(0, 80).replace(/[%_\\]/g, '\\$&') + '%'); w.push(`(a.action ILIKE $${p.length} OR a.detail ILIKE $${p.length} OR a.user_name ILIKE $${p.length})`); }
  if (Number(req.query.before)) { p.push(Number(req.query.before)); w.push(`a.id < $${p.length}`); }
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 5000);
  const rows = (await query(`SELECT a.id, a.user_id, a.user_name, a.role, a.area, a.action, a.detail, a.ip, a.created_at,
      to_char(a.created_at AT TIME ZONE $2, 'DD Mon YYYY, HH12:MI AM') AS at FROM activity_log a WHERE ${w.join(' AND ')} ORDER BY a.id DESC LIMIT ${limit + 1}`, p)).rows;
  const more = rows.length > limit; if (more) rows.pop();
  const meta = req.query.before ? {} : {
    people: (await query(`SELECT DISTINCT user_id AS id, user_name AS name FROM activity_log WHERE company_id=$1 AND user_id IS NOT NULL ORDER BY 2`, [C()])).rows,
    areas: (await query(`SELECT DISTINCT area FROM activity_log WHERE company_id=$1 ORDER BY 1`, [C()])).rows.map(r => r.area)
  };
  res.json({ rows, more, ...meta });
}));

// ---- Notification Preferences: everyone sets their own ----
const mine = async (req) => ((await query('SELECT notify FROM users WHERE id=$1 AND company_id=$2', [req.user.id, C()])).rows[0] || {}).notify;
router.get('/me/notifications', required(), wrap(async (req, res) => res.json({ ...push.prefs(await mine(req)), tz: TZ(), push_ready: push.ready() })));
router.put('/me/notifications', required(), wrap(async (req, res) => {
  const b = req.body || {}, hm = (v, d) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? v : d;
  const cur = push.prefs(await mine(req)), next = {};
  for (const k of push.KINDS) next[k] = k in b ? !!b[k] : cur[k];
  const q = b.quiet || {}; next.quiet = { on: 'on' in q ? !!q.on : cur.quiet.on, from: hm(q.from, cur.quiet.from), to: hm(q.to, cur.quiet.to) };
  await query('UPDATE users SET notify=$3 WHERE id=$1 AND company_id=$2', [req.user.id, C(), next]);
  res.json({ ...next, tz: TZ(), push_ready: push.ready() });
}));
// ---- Notifications for the installed web app and browsers ----
router.get('/push/key', required(), wrap(async (_req, res) => res.json({ key: await push.publicKey() })));
router.post('/push/subscribe', required(), wrap(async (req, res) => {
  const b = req.body || {}, k = b.keys || {}, ep = String(b.endpoint || '');
  if (!/^https:\/\//.test(ep) || ep.length > 1000 || !k.p256dh || !k.auth) return res.status(400).json({ error: 'This device did not give what is needed for notifications' });
  await query(`INSERT INTO web_push_subs(user_id,endpoint,p256dh,auth) VALUES($1,$2,$3,$4) ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth`,
    [req.user.id, ep, String(k.p256dh).slice(0, 200), String(k.auth).slice(0, 100)]);
  res.json({ ok: true });
}));
router.post('/push/unsubscribe', required(), wrap(async (req, res) => {
  await query('DELETE FROM web_push_subs WHERE endpoint=$1 AND user_id=$2', [String((req.body || {}).endpoint || ''), req.user.id]); res.json({ ok: true });
}));
module.exports = router;
