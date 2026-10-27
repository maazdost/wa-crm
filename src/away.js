const settings = require('./settings');
const wa = require('./whatsapp');
const { query } = require('./db');
const { saveOutbound } = require('./messages');
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

// Autoresponder: one polite message per 12 hours when a client writes outside working hours.
async function maybeAway(conv, waId) {
  const a = await settings.get('away'); if (!a.enabled) return;
  if (conv.last_away_at && Date.now() - new Date(conv.last_away_at) < 12 * 36e5) return;
  const local = new Date(new Date().toLocaleString('en-US', { timeZone: a.tz }));
  const mins = local.getHours() * 60 + local.getMinutes();
  if (a.days.includes(local.getDay()) && mins >= toMin(a.start) && mins < toMin(a.end)) return;
  const r = await wa.sendText(waId, a.message);
  await saveOutbound(conv, { senderType: 'bot', body: a.message, waMessageId: r.messages?.[0]?.id });
  await query('UPDATE conversations SET last_away_at=now() WHERE id=$1', [conv.id]);
}
module.exports = { maybeAway };
