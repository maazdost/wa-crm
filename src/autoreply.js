// Quick Message: when a client's message contains one of your keywords, the saved reply is sent automatically.
// Managers add and switch these on the Quick Message page. Works only for the company of the current request or job.
const { query } = require('./db');
const wa = require('./whatsapp');
const tenant = require('./tenant');
const mediaStore = require('./media');
const { saveOutbound } = require('./messages');

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "contains" looks for the keyword as a whole word or phrase, so "fee" does not fire on "coffee".
function matches(rule, text) {
  const t = norm(text); if (!t) return false;
  const words = (Array.isArray(rule.keywords) ? rule.keywords : []).map(norm).filter(Boolean);
  if (rule.match_type === 'exact') return words.includes(t);
  return words.some(k => new RegExp(`(^|[^\\p{L}\\p{N}])${escRe(k)}($|[^\\p{L}\\p{N}])`, 'u').test(t));
}

// Sends one saved file from the Media Library into a chat. Meta keeps uploaded files for a limited time, so it is uploaded fresh each time.
async function sendLibraryFile(conv, waId, file, { caption = '', senderType = 'bot', senderId = null, ctx = null } = {}) {
  const w = wa.forConversation(conv), kind = mediaStore.kindOf(file.mime);
  const up = await w.uploadMedia(file.data, file.mime, file.name);
  const sent = await w.sendMedia(waId, kind, up.id, { caption, filename: file.name, ctx });
  await mediaStore.store(up.id, file.mime, file.data);
  return saveOutbound(conv, { senderType, senderId, type: kind, body: caption || `[${kind}]`, waMessageId: sent.messages?.[0]?.id,
    mediaId: up.id, mediaMime: file.mime, mediaName: file.name, replyTo: ctx });
}

/** Returns true when a quick message was sent for this incoming message. */
async function maybeReply(conv, waId, msg) {
  if (!['text', 'interactive', 'button'].includes(msg.type) || !msg.body) return false;
  const cid = tenant.cid();
  const rules = (await query('SELECT * FROM auto_replies WHERE company_id=$1 AND active ORDER BY id', [cid])).rows;
  const rule = rules.find(r => matches(r, msg.body));
  if (!rule) return false;
  // Never answer the same chat with the same quick message again and again
  const recent = (await query(`SELECT 1 FROM auto_reply_log WHERE auto_reply_id=$1 AND conversation_id=$2 AND sent_at > now() - interval '2 minutes'`, [rule.id, conv.id])).rows[0];
  if (recent) return false;
  const file = rule.media_id && (await query('SELECT * FROM media_library WHERE id=$1 AND company_id=$2', [rule.media_id, cid])).rows[0];
  const btns = (Array.isArray(rule.buttons) ? rule.buttons : []).filter(Boolean).slice(0, 3);
  const w = wa.forConversation(conv);
  if (file) {
    const audio = mediaStore.kindOf(file.mime) === 'audio'; // voice files cannot carry text, so the text goes as its own message
    await sendLibraryFile(conv, waId, file, { caption: audio || btns.length ? '' : rule.body });
    if (!audio && !btns.length) return done(rule, conv);
  }
  const r = btns.length ? await w.sendButtons(waId, rule.body, btns.map((t, i) => ({ id: `qm${rule.id}_${i}`, title: t }))) : await w.sendText(waId, rule.body);
  await saveOutbound(conv, { senderType: 'bot', body: btns.length ? `${rule.body}\n\n🔘 ${btns.join('  ·  ')}` : rule.body, waMessageId: r.messages?.[0]?.id });
  return done(rule, conv);
}
async function done(rule, conv) {
  await query('UPDATE auto_replies SET sent_count = sent_count + 1, last_sent_at = now() WHERE id=$1', [rule.id]);
  await query('INSERT INTO auto_reply_log(auto_reply_id, conversation_id) VALUES($1,$2)', [rule.id, conv.id]);
  query(`DELETE FROM auto_reply_log WHERE sent_at < now() - interval '1 day'`).catch(() => {});
  return true;
}
module.exports = { maybeReply, matches, sendLibraryFile };
