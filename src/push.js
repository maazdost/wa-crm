const { query } = require('./db');
let messaging = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    messaging = admin.messaging();
    console.log('Push notifications enabled');
  }
} catch (e) { console.error('Push disabled:', e.message); }

// What each person chose on Notification Preferences. Anything they never touched stays on.
const KINDS = ['assigned', 'message', 'calls', 'missed', 'sound', 'desktop'];
const prefs = (saved) => { const s = saved || {}, q = s.quiet || {}; return { ...Object.fromEntries(KINDS.map(k => [k, s[k] !== false])), quiet: { on: !!q.on, from: q.from || '22:00', to: q.to || '08:00' } }; };
const ready = () => !!messaging;
function quietNow(q, now = new Date()) {
  if (!q || !q.on || q.from === q.to) return false;
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: process.env.REPORT_TZ || 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return q.from < q.to ? (t >= q.from && t < q.to) : (t >= q.from || t < q.to);
}
// kind says what the alert is about (assigned, message, calls, missed), so the person's own choice can switch it off.
async function allowed(userId, kind) {
  const u = (await query('SELECT notify FROM users WHERE id=$1', [userId])).rows[0], p = prefs(u && u.notify);
  return !(kind && p[kind] === false) && !quietNow(p.quiet);
}
async function notifyUser(userId, title, body, data = {}, kind) {
  if (!messaging || !userId) return;
  try {
    if (!(await allowed(userId, kind))) return;
    const { rows } = await query('SELECT token FROM devices WHERE user_id=$1', [userId]);
    if (!rows.length) return;
    const res = await messaging.sendEachForMulticast({
      tokens: rows.map(r => r.token),
      notification: { title, body: String(body || '').slice(0, 120) },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high', notification: { channelId: 'messages' } }
    });
    const dead = rows.filter((_, i) => !res.responses[i].success &&
      /not-registered|invalid-registration|invalid-argument/.test(res.responses[i].error?.code || '')).map(r => r.token);
    if (dead.length) await query('DELETE FROM devices WHERE token = ANY($1)', [dead]);
  } catch (e) { console.error('push error', e.message); }
}
module.exports = { notifyUser, prefs, ready, allowed, quietNow, KINDS };
