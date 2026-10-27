const { query } = require('./db');
const wa = require('./whatsapp');
const { saveOutbound } = require('./messages');
// New or unverified WhatsApp accounts may start conversations with only ~250 people per 24 hours.
const DAILY = () => Number(process.env.BROADCAST_DAILY_LIMIT || 250);
const first = (n) => (n || '').trim().split(/\s+/)[0] || 'there';

// Who a segment matches. Filters combine with AND, values inside one filter with OR. Opted-out contacts never match.
async function audience(seg = {}) {
  const w = ['NOT ct.opted_out'], p = [];
  const add = (sql, v) => { p.push(v); w.push(sql.replace('?', () => '$' + p.length)); };
  if (seg.lists?.length) add('ct.list_name = ANY(?)', seg.lists.map(String));
  if (seg.sources?.length) add("COALESCE(ct.source,'organic') = ANY(?)", seg.sources.map(String));
  if (seg.intents?.length) add('c.intent = ANY(?)', seg.intents.map(String));
  if (seg.labels?.length) add('EXISTS (SELECT 1 FROM conversation_labels cl WHERE cl.conversation_id=c.id AND cl.label_id = ANY(?))', seg.labels.map(Number));
  return (await query(`SELECT ct.id, ct.wa_id, ct.name FROM contacts ct LEFT JOIN conversations c ON c.contact_id=ct.id WHERE ${w.join(' AND ')} ORDER BY ct.id`, p)).rows;
}
const paramsFor = (varMap, contact) => (varMap || []).map(m => m.type === 'name' ? first(contact.name) : String(m.value || ''));

async function ensureConversation(contactId) {
  await query(`INSERT INTO conversations(contact_id,status,bot_step) VALUES($1,'bot','new') ON CONFLICT (contact_id) DO NOTHING`, [contactId]);
  return (await query('SELECT * FROM conversations WHERE contact_id=$1', [contactId])).rows[0];
}

async function runBatch(b) {
  const used = (await query(`SELECT COUNT(*)::int AS n FROM broadcast_recipients WHERE sent_at > now() - interval '24 hours'`)).rows[0].n;
  const room = DAILY() - used; if (room <= 0) return;
  const tpl = (await query('SELECT * FROM templates WHERE name=$1', [b.template_name])).rows[0];
  const rows = (await query(`SELECT * FROM broadcast_recipients WHERE broadcast_id=$1 AND status='queued' ORDER BY id LIMIT $2`, [b.id, Math.min(room, 20)])).rows;
  if (!rows.length) {
    const left = (await query(`SELECT COUNT(*)::int AS n FROM broadcast_recipients WHERE broadcast_id=$1 AND status='queued'`, [b.id])).rows[0].n;
    if (!left) await query(`UPDATE broadcasts SET status='done', finished_at=now() WHERE id=$1`, [b.id]);
    return;
  }
  for (const r of rows) {
    try {
      const sent = await wa.sendTemplate(r.wa_id, b.template_name, b.language, r.params);
      const id = sent.messages?.[0]?.id;
      await query(`UPDATE broadcast_recipients SET status='sent', wa_message_id=$2, sent_at=now() WHERE id=$1`, [r.id, id]);
      const conv = await ensureConversation(r.contact_id);
      const body = (tpl?.body || '').replace(/\{\{(\d+)\}\}/g, (_, i) => r.params[i - 1] ?? '');
      await saveOutbound(conv, { senderType: 'bot', type: 'template', body, templateName: b.template_name, waMessageId: id });
    } catch (e) {
      await query(`UPDATE broadcast_recipients SET status='failed', error=$2, sent_at=now() WHERE id=$1`, [r.id, String(e.message).slice(0, 200)]);
    }
    await new Promise(res => setTimeout(res, 120));
  }
}

let running = false;
async function tick() {
  if (running) return; running = true;
  try {
    await query(`UPDATE broadcasts SET status='sending', started_at=now() WHERE status='scheduled' AND scheduled_at <= now()`);
    for (const b of (await query(`SELECT * FROM broadcasts WHERE status='sending' ORDER BY id`)).rows) await runBatch(b);
  } catch (e) { console.error('broadcast worker', e.message); } finally { running = false; }
}
const start = () => setInterval(tick, 3000);
module.exports = { audience, paramsFor, start };
