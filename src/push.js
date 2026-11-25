// Notifications on phones and computers.
// 1. The Android app gets them through Firebase (needs FIREBASE_SERVICE_ACCOUNT on the server and an app built with Firebase).
// 2. The installed web app (iPhone "Add to Home Screen", Android, computer browsers) gets them through web push.
//    The server makes its own key pair for that on first start and keeps it in the database, so there is nothing to set up.
const { query } = require('./db');
let messaging = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const { initializeApp, cert } = require('firebase-admin/app');
    const { getMessaging } = require('firebase-admin/messaging');
    messaging = getMessaging(initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }));
    console.log('Push notifications enabled');
  }
} catch (e) { console.error('Push disabled:', e.message); }

let webpush = null, vapid = null, vapidP = null;
try { webpush = require('web-push'); } catch (e) { console.error('Web push disabled:', e.message); }
// The key pair is made once and reused. If two servers start together, the first one saved wins.
function keys() {
  if (!webpush) return Promise.resolve(null);
  if (!vapidP) vapidP = (async () => {
    const made = webpush.generateVAPIDKeys();
    await query(`INSERT INTO server_keys(key,value) VALUES('vapid',$1) ON CONFLICT (key) DO NOTHING`, [{ publicKey: made.publicKey, privateKey: made.privateKey }]);
    vapid = (await query(`SELECT value FROM server_keys WHERE key='vapid'`)).rows[0].value;
    return vapid;
  })().catch(e => { vapidP = null; console.error('web push keys', e.message); return null; });
  return vapidP;
}
const publicKey = async () => { const k = await keys(); return k ? k.publicKey : null; };

// What each person chose on Notification Preferences. Anything they never touched stays on.
const KINDS = ['assigned', 'message', 'calls', 'missed', 'sound', 'desktop', 'popup'];
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
async function sendFcm(userId, title, body, data) {
  if (!messaging) return;
  const { rows } = await query('SELECT token FROM devices WHERE user_id=$1', [userId]);
  if (!rows.length) return;
  const res = await messaging.sendEachForMulticast({
    tokens: rows.map(r => r.token),
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    android: { priority: 'high', notification: { channelId: 'messages' } }
  });
  const dead = rows.filter((_, i) => !res.responses[i].success &&
    /not-registered|invalid-registration|invalid-argument/.test(res.responses[i].error?.code || '')).map(r => r.token);
  if (dead.length) await query('DELETE FROM devices WHERE token = ANY($1)', [dead]);
}
// send is swapped in tests so nothing leaves the machine
const out = { send: (sub, payload, opt) => webpush.sendNotification(sub, payload, opt) };
async function sendWeb(userId, title, body, data) {
  const k = await keys(); if (!k) return 0;
  // Someone looking at the app right now already sees the pop up and hears the sound.
  if (await require('./realtime').watching(userId)) return 0;
  const { rows } = await query('SELECT endpoint, p256dh, auth FROM web_push_subs WHERE user_id=$1', [userId]);
  let sent = 0;
  await Promise.all(rows.map(async r => {
    try {
      await out.send({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, JSON.stringify({ title, body, ...data }),
        { vapidDetails: { subject: process.env.PUSH_CONTACT || 'mailto:support@teaminboxpro.com', publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 3600, urgency: 'high' });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await query('DELETE FROM web_push_subs WHERE endpoint=$1', [r.endpoint]); // the person removed the app or switched notifications off
      else console.error('web push', e.statusCode || '', e.message);
    }
  }));
  return sent;
}
async function notifyUser(userId, title, body, data = {}, kind) {
  if (!userId) return;
  try {
    if (!(await allowed(userId, kind))) return;
    const text = String(body || '').slice(0, 120);
    await Promise.all([sendFcm(userId, title, text, data).catch(e => console.error('push error', e.message)), sendWeb(userId, title, text, data)]);
  } catch (e) { console.error('push error', e.message); }
}
// A chat that nobody owns yet: tell the admins and managers of that company.
async function notifyManagers(companyId, title, body, data = {}, kind) {
  if (!companyId) return;
  const { rows } = await query(`SELECT id FROM users WHERE company_id=$1 AND is_active AND role IN ('admin','manager')`, [companyId]);
  await Promise.all(rows.map(r => notifyUser(r.id, title, body, data, kind)));
}
module.exports = { notifyUser, notifyManagers, prefs, ready, allowed, quietNow, KINDS, publicKey, out };
