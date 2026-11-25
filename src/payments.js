// Payments: a client's payment screenshot is caught and waits on the Payments page until a manager checks it.
// Confirm sends the client a WhatsApp receipt (number like WOF-0001), tags the chat Enrolled and marks their demo seat Joined.
// Not received sends a polite message. Everything here works only for the company of the current request or job.
const { query } = require('./db');
const wa = require('./whatsapp');
const tenant = require('./tenant');
const settings = require('./settings');
const autoreply = require('./autoreply');
const { saveOutbound } = require('./messages');

const norm = (s) => String(s || '').toLowerCase();
const LABEL_WAIT = 'Payment to check', LABEL_DONE = 'Enrolled';

async function label(convId, name, color, on = true) {
  const l = (await query(`INSERT INTO labels(company_id,name,color) VALUES($1,$2,$3) ON CONFLICT (company_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [tenant.cid(), name, color])).rows[0];
  if (on) await query('INSERT INTO conversation_labels(conversation_id,label_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [convId, l.id]);
  else await query('DELETE FROM conversation_labels WHERE conversation_id=$1 AND label_id=$2', [convId, l.id]);
}

/** Saves a payment to check for this photo or file, once. Returns the new payment, or null if it was already there. */
async function flag(conv, messageId, by = null) {
  const p = (await query(`INSERT INTO payments(company_id, conversation_id, contact_id, message_id, flagged_by) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT (message_id) DO NOTHING RETURNING *`, [tenant.cid(), conv.id, conv.contact_id, messageId, by])).rows[0];
  if (!p) return null;
  await label(conv.id, LABEL_WAIT, '#d97706').catch(e => console.error('payment tag', e.message));
  const who = (await query(`SELECT COALESCE(NULLIF(name,''), NULLIF(profile_name,''), '+' || wa_id) AS n FROM contacts WHERE id=$1`, [conv.contact_id])).rows[0];
  require('./push').notifyManagers(tenant.cid(), 'Payment to check', `${who ? who.n : 'A client'} sent a payment screenshot`, { conversationId: conv.id }, 'message');
  require('./realtime').toConversation({ company_id: tenant.cid() }, 'payment:new', { conversationId: conv.id, id: p.id });
  return p;
}

/**
 * Incoming photo or PDF: is it probably a payment? Yes when its caption or the client's last messages talk about paying,
 * or when the team sent the fees or joining steps in the last 7 days.
 */
async function detect(conv, msg, saved) {
  const s = await settings.get('payments'); if (!s.enabled) return null;
  const isDoc = msg.type === 'document' && /pdf|image/.test(String(msg.mime || ''));
  if (msg.type !== 'image' && !isDoc) return null;
  const words = (Array.isArray(s.words) ? s.words : []).map(norm).filter(Boolean);
  const said = (t) => words.some(w => norm(t).includes(w));
  let hit = said(msg.body && !/^\[\w+\]$/.test(msg.body) ? msg.body : '');
  if (!hit) {
    const recent = (await query(`SELECT direction, body FROM messages WHERE conversation_id=$1 AND id <> $2 AND created_at > now() - interval '7 days' ORDER BY id DESC LIMIT 30`, [conv.id, saved.id])).rows;
    hit = recent.some(m => m.direction === 'in' ? said(m.body) : said(m.body) || /\b(pkr|rs\.?|fee|fees)\b/i.test(m.body || ''));
  }
  return hit ? flag(conv, saved.id, null) : null;
}

const money = (n, cur) => `${cur || 'PKR'} ${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const receiptNo = (s, n) => `${s.prefix || 'RCPT'}-${String(n).padStart(4, '0')}`;

/** Sends a text into the chat if the 24 hour window is open. Returns { sent, why }. */
async function say(conv, contact, text) {
  if (!text) return { sent: false, why: 'No message' };
  if (!conv.last_customer_message_at || new Date(conv.last_customer_message_at) < new Date(Date.now() - 24 * 3600e3)) return { sent: false, why: 'The 24 hour window is closed. Send it with a template from the chat.' };
  const r = await wa.forConversation(conv).sendText(contact.wa_id, text);
  await saveOutbound(conv, { senderType: 'bot', body: text, waMessageId: r.messages?.[0]?.id });
  return { sent: true };
}

/**
 * Confirms a payment: amount, what it is for, method. Gives the next receipt number, sends the receipt,
 * tags the chat Enrolled (and takes off Payment to check), and marks the client's demo seat Joined.
 */
async function confirm(p, { amount, currency = 'PKR', item = '', product_id = null, method = '', note = '', by }) {
  const s = await settings.get('payments'), cid = tenant.cid();
  // the next number for this company; the unique index makes two confirms at once safe (the second one retries)
  let row = null;
  for (let i = 0; i < 3 && !row; i++) {
    try {
      row = (await query(`UPDATE payments SET status='confirmed', amount=$2, currency=$3, item=$4, product_id=$5, method=$6, note=$7, decided_by=$8, decided_at=now(),
          receipt_no=(SELECT COALESCE(MAX(receipt_no),0)+1 FROM payments WHERE company_id=$9) WHERE id=$1 AND status='pending' RETURNING *`,
        [p.id, amount, currency, item, product_id, method, note, by, cid])).rows[0];
      if (!row) return { error: 'This payment was already checked' };
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  const conv = (await query('SELECT * FROM conversations WHERE id=$1', [row.conversation_id])).rows[0];
  const contact = (await query('SELECT * FROM contacts WHERE id=$1', [row.contact_id])).rows[0];
  await label(conv.id, LABEL_WAIT, '#d97706', false).catch(() => {});
  await label(conv.id, LABEL_DONE, '#15803d').catch(() => {});
  await query(`UPDATE demo_bookings SET status='joined', updated_at=now() WHERE id = (SELECT id FROM demo_bookings WHERE company_id=$1 AND contact_id=$2 AND status IN ('came','booked') ORDER BY day DESC LIMIT 1)`, [cid, row.contact_id]).catch(() => {});
  const co = (await query('SELECT name FROM companies WHERE id=$1', [cid])).rows[0] || {};
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: s.tz || 'Asia/Karachi' });
  const text = autoreply.fill(String(s.receipt || '').replace(/\{\{\s*(receipt|amount|item|method|date|company)\s*\}\}/gi, (_, k) => ({
    receipt: receiptNo(s, row.receipt_no), amount: money(row.amount, row.currency), item: row.item || '-', method: row.method || '-', date: today, company: co.name || '' })[k.toLowerCase()]), contact).trim();
  const sent = await say(conv, contact, text).catch(e => ({ sent: false, why: e.message }));
  if (sent.sent) await query('UPDATE payments SET receipt_sent=TRUE WHERE id=$1', [row.id]);
  require('./realtime').toConversation(conv, 'conversation:updated', { conversationId: conv.id });
  return { payment: { ...row, receipt: receiptNo(s, row.receipt_no) }, sent };
}

/** Not received: the client is told kindly. Not a payment: nothing is sent. Both take off the Payment to check tag. */
async function reject(p, { notify, by }) {
  const s = await settings.get('payments');
  const row = (await query(`UPDATE payments SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1 AND status='pending' RETURNING *`, [p.id, notify ? 'not_received' : 'dismissed', by])).rows[0];
  if (!row) return { error: 'This payment was already checked' };
  const conv = (await query('SELECT * FROM conversations WHERE id=$1', [row.conversation_id])).rows[0];
  const left = (await query(`SELECT 1 FROM payments WHERE conversation_id=$1 AND status='pending' LIMIT 1`, [row.conversation_id])).rows[0];
  if (!left) await label(conv.id, LABEL_WAIT, '#d97706', false).catch(() => {});
  let sent = null;
  if (notify) { const contact = (await query('SELECT * FROM contacts WHERE id=$1', [row.contact_id])).rows[0]; sent = await say(conv, contact, autoreply.fill(s.not_received, contact)).catch(e => ({ sent: false, why: e.message })); }
  require('./realtime').toConversation(conv, 'conversation:updated', { conversationId: conv.id });
  return { payment: row, sent };
}

module.exports = { detect, flag, confirm, reject, receiptNo };
