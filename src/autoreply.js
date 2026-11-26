// Quick Message: when a client's message matches one of your keywords (for example the ready-made first message of an ad),
// a saved sequence of messages is sent automatically, and the chat can get a tag and an agent.
// Managers build these on the Quick Message page. Everything here works only for the company of the current request or job.
const { query } = require('./db');
const wa = require('./whatsapp');
const tenant = require('./tenant');
const mediaStore = require('./media');
const { saveOutbound } = require('./messages');
const { assignConversation } = require('./assign');

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "contains" looks for the keyword as a whole word or phrase, so "fee" does not fire on "coffee".
function matches(rule, text) {
  const t = norm(text); if (!t) return false;
  const words = (Array.isArray(rule.keywords) ? rule.keywords : []).map(norm).filter(Boolean);
  if (rule.match_type === 'exact') return words.includes(t);
  return words.some(k => new RegExp(`(^|[^\\p{L}\\p{N}])${escRe(k)}($|[^\\p{L}\\p{N}])`, 'u').test(t));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// {{name}}, {{first_name}} and {{whatsapp_name}} in a message are replaced with the client's details
function fill(text, contact) {
  const full = (contact.name || contact.profile_name || '').trim(), v = { name: full || 'there', first_name: full.split(/\s+/)[0] || 'there', whatsapp_name: (contact.profile_name || full || 'there').trim() };
  return String(text || '').replace(/\{\{\s*(name|first_name|whatsapp_name)\s*\}\}/gi, (_, k) => v[k.toLowerCase()]);
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

// One message of a sequence: text, or a file with a caption, with reply buttons or one website link button.
async function sendStep(rule, conv, waId, contact, step, file) {
  const w = wa.forConversation(conv), text = fill(step.text, contact).trim();
  const btns = (Array.isArray(step.buttons) ? step.buttons : []).filter(b => b && b.title).slice(0, 3);
  const link = btns.find(b => b.type === 'url' && b.url);
  const note = link ? `\n\n🔗 ${link.title}: ${link.url}` : btns.length ? `\n\n🔘 ${btns.map(b => b.title).join('  ·  ')}` : '';
  const withButtons = (body, head) => link ? w.sendLinkButton(waId, body, link.title, link.url, head)
    : w.sendButtons(waId, body, btns.map((b, i) => ({ id: rule.btnId ? rule.btnId(i) : `qm${rule.id}_${i}`, title: b.title })), head);
  if (file) {
    const kind = step.type === 'file' ? 'document' : mediaStore.kindOf(file.mime);
    if (kind === 'audio') { // voice files cannot carry text or buttons: the text follows as its own message
      await sendLibraryFile(conv, waId, file);
    } else {
      const up = await w.uploadMedia(file.data, file.mime, file.name);
      const sent = btns.length ? await withButtons(text || file.name, { kind, id: up.id, filename: file.name }) : await w.sendMedia(waId, kind, up.id, { caption: text, filename: file.name });
      await mediaStore.store(up.id, file.mime, file.data);
      await saveOutbound(conv, { senderType: 'bot', type: kind, body: (text + note).trim() || `[${kind}]`, waMessageId: sent.messages?.[0]?.id, mediaId: up.id, mediaMime: file.mime, mediaName: file.name });
      return;
    }
  }
  if (!text) return;
  const r = btns.length ? await withButtons(text) : await w.sendText(waId, text);
  await saveOutbound(conv, { senderType: 'bot', body: text + note, waMessageId: r.messages?.[0]?.id });
}

/** The quick message that should answer this incoming message, or null. */
async function find(conv, contact, msg) {
  if (!['text', 'interactive', 'button'].includes(msg.type) || !msg.body) return null;
  if (conv.status === 'bot' && ['ask_intent', 'ask_name'].includes(conv.bot_step)) return null; // the welcome bot is in the middle of its questions
  const rules = (await query('SELECT * FROM auto_replies WHERE company_id=$1 AND active ORDER BY (match_type=\'exact\') DESC, id', [tenant.cid()])).rows;
  const rule = rules.find(r => matches(r, msg.body));
  if (!rule || (rule.respect_opt_out && contact.opted_out)) return null;
  // Never answer the same chat with the same quick message again and again
  const recent = (await query(`SELECT 1 FROM auto_reply_log WHERE auto_reply_id=$1 AND conversation_id=$2 AND sent_at > now() - interval '30 seconds'`, [rule.id, conv.id])).rows[0];
  return recent ? null : rule;
}

/**
 * Runs a quick message: adds the tag, gives the chat an agent (the chosen one, else the usual automatic choice when the chat has no agent yet),
 * then sends the messages in order in the background. Returns the updated conversation.
 */
async function run(rule, conv, contact, waId) {
  const cid = tenant.cid();
  await query('UPDATE auto_replies SET sent_count = sent_count + 1, last_sent_at = now() WHERE id=$1', [rule.id]);
  await query('INSERT INTO auto_reply_log(auto_reply_id, conversation_id) VALUES($1,$2)', [rule.id, conv.id]);
  query(`DELETE FROM auto_reply_log WHERE sent_at < now() - interval '1 day'`).catch(() => {});
  if (rule.tag_id) await query('INSERT INTO conversation_labels(conversation_id,label_id) SELECT $1, id FROM labels WHERE id=$2 AND company_id=$3 ON CONFLICT DO NOTHING', [conv.id, rule.tag_id, cid]);

  const wasNew = conv.status === 'bot';
  const owner = conv.assigned_to && (await query('SELECT is_active FROM users WHERE id=$1', [conv.assigned_to])).rows[0];
  const chosen = !conv.locked_to && rule.assign_to && (await query('SELECT id FROM users WHERE id=$1 AND company_id=$2 AND is_active', [rule.assign_to, cid])).rows[0];
  let next = null;
  if (chosen) next = (await query(`UPDATE conversations SET assigned_to=$2, status='open', bot_step='done', assigned_at=CASE WHEN assigned_to IS DISTINCT FROM $2 THEN now() ELSE assigned_at END WHERE id=$1 RETURNING *`, [conv.id, chosen.id])).rows[0];
  else if (owner?.is_active) next = (await query(`UPDATE conversations SET status='open', bot_step='done' WHERE id=$1 RETURNING *`, [conv.id])).rows[0];
  else {
    await query(`UPDATE conversations SET bot_step='done' WHERE id=$1`, [conv.id]);
    next = (await assignConversation(conv.id, conv.team)) || (await query('SELECT * FROM conversations WHERE id=$1', [conv.id])).rows[0];
  }
  if (wasNew) require('./drip').enroll(contact.id).catch(e => console.error('follow-up enroll', e.message));

  const steps = (Array.isArray(rule.steps) ? rule.steps : []).slice(0, 10);
  const ids = [...new Set(steps.map(s => Number(s.media_id)).filter(Boolean))];
  const files = ids.length ? (await query('SELECT * FROM media_library WHERE company_id=$1 AND id = ANY($2::int[])', [cid, ids])).rows : [];
  const pids = [...new Set(steps.map(s => Number(s.product_id)).filter(Boolean))];
  const products = pids.length ? (await query('SELECT * FROM products WHERE company_id=$1 AND id = ANY($2::int[])', [cid, pids])).rows : [];
  (async () => {
    for (const step of steps) {
      const wait = Math.min(60, Math.max(0, Number(step.delay) || 0));
      if (wait) await sleep(wait * 1000);
      if (step.type === 'product') { // a product from the catalog; a product that was deleted since is skipped
        const p = products.find(x => x.id === Number(step.product_id));
        if (p) await require('./catalog').send(next, waId, p).catch(e => console.error('quick message product', e.message));
        continue;
      }
      await sendStep(rule, next, waId, contact, step, files.find(f => f.id === Number(step.media_id))).catch(e => console.error('quick message step', e.message));
    }
  })();
  return { conversation: next, newlyAssigned: !!next.assigned_to && next.assigned_to !== conv.assigned_to };
}
module.exports = { find, run, matches, fill, sendLibraryFile, sendStep };
