const express = require('express');
const { query } = require('../db');
const wa = require('../whatsapp');
const bot = require('../bot');
const rt = require('../realtime');
const { assignConversation } = require('../assign');
const { saveInbound } = require('../messages');
const mediaStore = require('../media');
const push = require('../push');
const router = express.Router();

// Meta webhook verification
router.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// Process messages from the same customer one at a time (prevents double bot replies)
const chains = new Map();
const serial = (key, fn) => {
  const next = (chains.get(key) || Promise.resolve()).then(fn).catch(e => console.error('webhook error', e));
  chains.set(key, next);
  next.finally(() => { if (chains.get(key) === next) chains.delete(key); });
  return next;
};

function extract(m) {
  const base = { waMessageId: m.id, type: m.type, referral: !!m.referral };
  if (m.type === 'text') return { ...base, body: m.text.body };
  if (m.type === 'interactive') {
    const r = m.interactive.button_reply || m.interactive.list_reply || {};
    return { ...base, body: r.title, buttonId: r.id };
  }
  if (m.type === 'button') return { ...base, body: m.button?.text, buttonId: m.button?.payload };
  const media = m[m.type] || {};
  return { ...base, body: media.caption || `[${m.type}]`, mediaId: media.id, mime: media.mime_type, filename: media.filename };
}

async function handleMessage(m, profileName) {
  const msg = extract(m);
  const waId = m.from;
  const contact = (await query(
    `INSERT INTO contacts(wa_id,name,source) VALUES($1,$2,$3)
     ON CONFLICT (wa_id) DO UPDATE SET name = COALESCE(contacts.name, EXCLUDED.name) RETURNING *`,
    [waId, profileName || null, m.referral ? 'ad' : 'organic'])).rows[0];
  let conv = (await query(
    `INSERT INTO conversations(contact_id) VALUES($1) ON CONFLICT (contact_id) DO UPDATE SET contact_id=EXCLUDED.contact_id RETURNING *`,
    [contact.id])).rows[0];

  const saved = await saveInbound(conv, msg);
  if (!saved) return; // duplicate delivery
  conv = saved.conversation;
  wa.markRead(m.id);
  if (msg.mediaId) mediaStore.ensure(msg.mediaId).catch(e => console.error('media download', e.message));

  // Returning client whose chat was closed: stay with the same agent (sticky), reassign only if agent is gone
  if (conv.status === 'closed') {
    const owner = conv.assigned_to && (await query('SELECT is_active FROM users WHERE id=$1', [conv.assigned_to])).rows[0];
    if (owner?.is_active) conv = (await query(`UPDATE conversations SET status='open' WHERE id=$1 RETURNING *`, [conv.id])).rows[0];
    else conv = (await assignConversation(conv.id, conv.team)) || conv;
  }

  if (await bot.handle(conv, contact, msg)) {
    rt.toConversation(conv, 'message:new', { conversationId: conv.id, message: saved.message });
    return;
  }
  // Agent-owned chat: if the owner was deactivated, hand to someone else
  if (conv.assigned_to) {
    const owner = (await query('SELECT is_active FROM users WHERE id=$1', [conv.assigned_to])).rows[0];
    if (owner && !owner.is_active) conv = (await assignConversation(conv.id, conv.team)) || conv;
  }
  rt.toConversation(conv, 'message:new', { conversationId: conv.id, message: saved.message });
  if (conv.assigned_to) push.notifyUser(conv.assigned_to, contact.name || '+' + waId, msg.body || '', { conversationId: conv.id });
}

router.post('/', (req, res) => {
  console.log('[webhook] received', JSON.stringify(req.body).slice(0, 400));
  if (!wa.verifySignature(req.rawBody, req.headers['x-hub-signature-256'])) {
    console.warn('[webhook] REJECTED: signature mismatch, so WA_APP_SECRET on the server is wrong');
    return res.sendStatus(401);
  }
  res.sendStatus(200); // acknowledge fast, process after
  for (const entry of req.body.entry || []) for (const change of entry.changes || []) {
    const v = change.value || {};
    for (const m of v.messages || []) {
      const name = v.contacts?.find(c => c.wa_id === m.from)?.profile?.name;
      serial(m.from, () => handleMessage(m, name));
    }
    for (const s of v.statuses || []) {
      query(`UPDATE messages SET status=$2, error=$3 WHERE wa_message_id=$1
               AND status <> 'read' AND NOT (status='delivered' AND $2='sent') RETURNING conversation_id`,
        [s.id, s.status, s.errors?.[0]?.title || null])
        .then(async r => {
          const row = r.rows[0]; if (!row) return;
          const conv = (await query('SELECT assigned_to FROM conversations WHERE id=$1', [row.conversation_id])).rows[0];
          rt.toConversation(conv || {}, 'message:status', { conversationId: row.conversation_id, waMessageId: s.id, status: s.status });
        })
        .catch(() => {});
    }
  }
});

module.exports = router;
