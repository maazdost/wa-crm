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

async function notifyUser(userId, title, body, data = {}) {
  if (!messaging || !userId) return;
  try {
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
module.exports = { notifyUser };
