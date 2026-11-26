const express = require('express');
const { query } = require('../db');
const wa = require('../whatsapp');
const bot = require('../bot');
const rt = require('../realtime');
const { assignConversation } = require('../assign');
const { saveInbound, saveOutbound } = require('../messages');
const mediaStore = require('../media');
const push = require('../push');
const { maybeAway } = require('../away');
const autoreply = require('../autoreply');
const flows = require('../flows');
const adroute = require('../adroute');
const demo = require('../demo');
const payments = require('../payments');
const ai = require('../ai');
const settings = require('../settings');
const numbers = require('../numbers');
const calls = require('../calls');
const tenant = require('../tenant');
const source = require('../source');
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
  const base = { waMessageId: m.id, type: m.type, referral: !!m.referral, replyTo: (m.type !== 'interactive' && m.type !== 'button' && m.context) ? m.context.id : undefined };
  if (m.type === 'text') return { ...base, body: m.text.body };
  if (m.type === 'interactive' && m.interactive.type === 'call_permission_reply') {
    const r = m.interactive.call_permission_reply || {};
    return { ...base, body: r.response === 'accept' ? '✅ Client allowed calls' : '🚫 Client declined calls', callPermission: true };
  }
  if (m.type === 'interactive') {
    const r = m.interactive.button_reply || m.interactive.list_reply || {};
    return { ...base, body: r.title, buttonId: r.id };
  }
  if (m.type === 'button') return { ...base, body: m.button?.text, buttonId: m.button?.payload };
  if (m.type === 'reaction') return { ...base, reaction: { to: m.reaction?.message_id, emoji: m.reaction?.emoji || '' } };
  const media = m[m.type] || {};
  // GIFs arrive as short videos marked to play like a GIF (or, rarely, as image/gif): they are kept as type 'gif' and loop in the chat
  const gif = (m.type === 'video' && (media.gif_playback || media.animated)) || media.mime_type === 'image/gif';
  return { ...base, type: gif ? 'gif' : m.type, body: media.caption || `[${gif ? 'gif' : m.type}]`, mediaId: media.id, mime: media.mime_type, filename: media.filename };
}

async function handleMessage(m, profileName, numId) {
  const msg = extract(m);
  const waId = m.from;
  const cid = tenant.cid();
  // Where they came from: a new person is from WhatsApp, or from the Facebook or Instagram ad or post they clicked.
  const ref = source.fromReferral(m.referral);
  const contact = (await query(
    `INSERT INTO contacts(company_id,wa_id,profile_name,source,channel) VALUES($4,$1,$2,$3,$5)
     ON CONFLICT (company_id,wa_id) DO UPDATE SET profile_name = CASE WHEN contacts.custom_name THEN contacts.profile_name ELSE COALESCE(EXCLUDED.profile_name, contacts.profile_name) END RETURNING *`,
    [waId, profileName || null, m.referral ? 'ad' : 'organic', cid, ref ? ref.channel : 'whatsapp'])).rows[0];
  // The latest ad click is kept with its link. Someone who first wrote on WhatsApp by themselves and now comes through an ad
  // counts as coming from that ad; a channel typed or imported earlier (Website, Referral...) stays.
  if (ref) await query(`UPDATE contacts SET channel=CASE WHEN channel IS NULL OR channel='whatsapp' THEN COALESCE($2,channel) ELSE channel END,
    source=CASE WHEN source='organic' THEN 'ad' ELSE source END, ad_source_url=COALESCE($3,ad_source_url), ad_source_type=$4, ad_source_id=COALESCE($5,ad_source_id), ad_headline=COALESCE($6,ad_headline), ad_clicked_at=now() WHERE id=$1`,
    [contact.id, ref.channel, ref.url, ref.type, ref.id, ref.headline]).catch(e => console.error('ad source', e.message));
  if (contact.is_personal) return; // marked "not a client": nothing is stored and nothing is sent
  let conv = (await query(
    `INSERT INTO conversations(company_id, contact_id, wa_number_id) VALUES($3,$1,$2) ON CONFLICT (contact_id) DO UPDATE SET wa_number_id=COALESCE(EXCLUDED.wa_number_id, conversations.wa_number_id) RETURNING *`,
    [contact.id, numId || null, cid])).rows[0];
  const w = wa.forConversation(conv); // replies leave from the number the client wrote to

  // A reaction (👍 ❤️ 😂 ...) is shown on the message it answers, like on the phone; an empty emoji means it was taken back.
  // It is not a new chat message, so the bot and the reply window are left alone.
  if (msg.reaction) {
    const r = (await query(`UPDATE messages SET reaction=$3 WHERE conversation_id=$1 AND wa_message_id=$2 RETURNING id`, [conv.id, msg.reaction.to || '', msg.reaction.emoji || null])).rows[0];
    if (r) rt.toConversation(conv, 'message:reaction', { conversationId: conv.id, messageId: r.id, emoji: msg.reaction.emoji || null });
    return;
  }

  const saved = await saveInbound(conv, msg);
  if (!saved) return; // duplicate delivery
  query('UPDATE chat_flags SET archived=FALSE WHERE conversation_id=$1 AND archived', [conv.id]).catch(() => {}); // a new message brings an archived chat back
  conv = saved.conversation;
  if (msg.mediaId) mediaStore.ensure(msg.mediaId, w).catch(e => console.error('media download', e.message));
  if (msg.mediaId) await payments.detect(conv, msg, saved.message).catch(e => console.error('payment check', e.message)); // a payment screenshot waits on the Payments page
  if (msg.callPermission) { rt.toConversation(conv, 'message:new', { conversationId: conv.id, message: saved.message, from: { name: contact.profile_name || contact.name || '', wa_id: waId }, assignedTo: conv.assigned_to || null }); return; } // answer to "May we call you?": not a chat message for the bot

  // Opt-out / opt-in keywords (WhatsApp expects businesses to honour these)
  const word = (msg.type === 'text' ? (msg.body || '') : '').trim().toLowerCase();
  const optWord = /^(stop|unsubscribe)$/.test(word) ? 'out' : (contact.opted_out && /^(start|subscribe)$/.test(word)) ? 'in' : null;
  if (optWord) {
    await query('UPDATE contacts SET opted_out=$2 WHERE id=$1', [contact.id, optWord === 'out']);
    const t = optWord === 'out' ? 'You have been unsubscribed from our promotional messages. Reply START to receive them again.' : 'Welcome back! You will receive our messages again.';
    const sent = await w.sendText(waId, t);
    await saveOutbound(conv, { senderType: 'bot', body: t, waMessageId: sent.messages?.[0]?.id });
    w.markRead(m.id);
    rt.toConversation(conv, 'message:new', { conversationId: conv.id, message: saved.message, from: { name: contact.profile_name || contact.name || '', wa_id: waId }, assignedTo: conv.assigned_to || null });
    return;
  }
  // Chatbot: the client is answering a question of a flow, so the flow goes on from there.
  const tellTeam = (out) => {
    conv = out.conversation;
    w.markRead(m.id);
    rt.toConversation(conv, 'message:new', { conversationId: conv.id, message: saved.message, from: { name: contact.profile_name || contact.name || '', wa_id: waId }, assignedTo: conv.assigned_to || null });
    if (!out.finished) return;
    const who = contact.name || contact.profile_name || '+' + waId;
    if (conv.assigned_to) {
      if (out.newlyAssigned) { push.notifyUser(conv.assigned_to, 'New client assigned', `${who}: ${out.flow.name}`, { conversationId: conv.id }, 'assigned'); rt.toUser(conv.assigned_to, 'conversation:assigned', { conversationId: conv.id, name: who }); }
      else push.notifyUser(conv.assigned_to, who, msg.body || '', { conversationId: conv.id }, 'message');
      rt.toConversation(conv, 'conversation:updated', { conversationId: conv.id });
    } else rt.toConversation({}, 'conversation:unassigned', { conversationId: conv.id });
  };
  const going = await flows.reply(conv, contact, msg, waId);
  if (going) return tellTeam(going);
  // Demo class booking: a tap on a demo button, or a message asking for the demo
  const dm = await demo.handle(conv, contact, msg).catch(e => { console.error('demo class', e.message); return null; });
  if (dm) return tellTeam(dm);
  // Quick Message: the message matches one of the company's keywords (for example the ready-made first message of an ad).
  // Its saved messages are sent instead of the welcome bot, and the chat gets its tag and agent.
  const rule = await autoreply.find(conv, contact, msg).catch(e => { console.error('quick message', e.message); return null; });
  if (rule) {
    const out = await autoreply.run(rule, conv, contact, waId);
    conv = out.conversation;
    w.markRead(m.id);
    rt.toConversation(conv, 'message:new', { conversationId: conv.id, message: saved.message, from: { name: contact.profile_name || contact.name || '', wa_id: waId }, assignedTo: conv.assigned_to || null });
    if (conv.assigned_to) {
      const who = contact.profile_name || contact.name || '+' + waId;
      if (out.newlyAssigned) { push.notifyUser(conv.assigned_to, 'New client assigned', `${who}: ${rule.name}`, { conversationId: conv.id }, 'assigned'); rt.toUser(conv.assigned_to, 'conversation:assigned', { conversationId: conv.id, name: who }); }
      else push.notifyUser(conv.assigned_to, who, msg.body || '', { conversationId: conv.id }, 'message');
      rt.toConversation(conv, 'conversation:updated', { conversationId: conv.id });
    } else rt.toConversation({}, 'conversation:unassigned', { conversationId: conv.id });
    return;
  }
  // Chatbot started by a keyword
  const kflow = await flows.findKeyword(conv, msg).catch(e => { console.error('chatbot', e.message); return null; });
  if (kflow) return tellTeam(await flows.start(kflow, conv, contact, waId));
  // Optional gate: only start the bot for ad clicks, imported contacts, or messages with the chosen words
  const gate = await settings.get('gate');
  if (gate.mode === 'keywords' && (conv.bot_step === 'held' || (conv.status === 'bot' && conv.bot_step === 'new'))) {
    const body = (msg.body || '').toLowerCase();
    const ok = msg.referral || contact.list_name || gate.keywords.some(k => body.includes(k));
    if (!ok) {
      await query(`UPDATE conversations SET status='closed', bot_step='held' WHERE id=$1`, [conv.id]);
      rt.toConversation({}, 'conversation:held', { conversationId: conv.id });
      return;
    }
    if (conv.bot_step === 'held') conv = (await query(`UPDATE conversations SET status='bot', bot_step='new' WHERE id=$1 RETURNING *`, [conv.id])).rows[0];
  }
  // AI Agent, returning client: when the company chose it, the AI answers first and the chat goes back to its agent on hand over
  conv = await ai.reopen(conv).catch(e => { console.error('ai agent', e.message); return conv; });
  // Returning client whose chat was closed: stay with the same agent (sticky), reassign only if agent is gone
  if (conv.status === 'closed') {
    const owner = conv.assigned_to && (await query('SELECT is_active FROM users WHERE id=$1', [conv.assigned_to])).rows[0];
    if (owner?.is_active) conv = (await query(`UPDATE conversations SET status='open' WHERE id=$1 RETURNING *`, [conv.id])).rows[0];
    else conv = (await assignConversation(conv.id, conv.team)) || conv;
  }

  // Ad routing: a new client from an ad that one of the company's ad rules fits (by the ad's details or the words of the first message)
  // skips the welcome menu and goes to that department.
  if (conv.status === 'bot' && conv.bot_step === 'new') {
    const arule = await adroute.find(ref, msg.body).catch(e => { console.error('ad routing', e.message); return null; });
    if (arule) return tellTeam(await adroute.run(arule, conv, contact, waId));
  }
  // A switched-on welcome chatbot takes the place of the built-in welcome bot. Without one, nothing changes.
  if (conv.status === 'bot' && ['new', 'flow'].includes(conv.bot_step)) {
    const wflow = await flows.welcome();
    if (wflow) return tellTeam(await flows.start(wflow, conv, contact, waId));
    if (conv.bot_step === 'flow') conv = (await query(`UPDATE conversations SET bot_step='new' WHERE id=$1 RETURNING *`, [conv.id])).rows[0];
  }
  // AI Agent: answers from the company's notes in place of the built-in welcome bot, and hands over when unsure
  const aiOut = await ai.reply(conv, contact, msg, waId).catch(e => { console.error('ai agent', e.message); return null; });
  if (aiOut) return tellTeam(aiOut);
  if (await bot.handle(conv, contact, msg)) {
    w.markRead(m.id);
    rt.toConversation(conv, 'message:new', { conversationId: conv.id, message: saved.message, from: { name: contact.profile_name || contact.name || '', wa_id: waId }, assignedTo: conv.assigned_to || null });
    return;
  }
  // Agent-owned chat: if the owner was deactivated, hand to someone else
  if (conv.assigned_to) {
    const owner = (await query('SELECT is_active FROM users WHERE id=$1', [conv.assigned_to])).rows[0];
    if (owner && !owner.is_active) conv = (await assignConversation(conv.id, conv.team)) || conv;
  }
  rt.toConversation(conv, 'message:new', { conversationId: conv.id, message: saved.message, from: { name: contact.profile_name || contact.name || '', wa_id: waId }, assignedTo: conv.assigned_to || null });
  if (conv.assigned_to) push.notifyUser(conv.assigned_to, contact.profile_name || contact.name || '+' + waId, msg.body || '', { conversationId: conv.id }, 'message');
  else push.notifyManagers(conv.company_id || tenant.cid(), contact.profile_name || contact.name || '+' + waId, msg.body || '', { conversationId: conv.id }, 'message');
  await maybeAway(conv, waId).catch(e => console.error('away message', e.message));
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
      const pid = v.metadata?.phone_number_id; // which of your numbers the client wrote to
      serial(`${pid || ''}|${m.from}`, async () => {
        const num = pid ? await numbers.byPhoneId(pid) : null;
        if (pid && !num) { console.warn(`[webhook] message for phone number id ${pid}, which is not added in Settings > WhatsApp numbers; ignored`); return; }
        // The number the client wrote to decides the company. Messages without a number ID (older setups) go to company 1.
        return tenant.run(num ? num.company_id : 1, () => handleMessage(m, name, num && num.id));
      });
    }
    for (const ev of v.calls || []) {
      const pid = v.metadata?.phone_number_id;
      (async () => {
        const num = pid ? await numbers.byPhoneId(pid) : null;
        if (pid && !num) return console.warn(`[webhook] call for phone number id ${pid}, which is not added in Settings > WhatsApp numbers; ignored`);
        await tenant.run(num ? num.company_id : 1, () => calls.onEvent(ev, v, num && num.id));
      })().catch(e => console.error('call event', e.message));
    }
    for (const s of v.statuses || []) {
      if (s.type === 'call') { calls.onStatus(s).catch(e => console.error('call status', e.message)); continue; }
      if (s.status === 'failed') console.error('message not delivered', s.id, JSON.stringify(s.errors || []).slice(0, 600));
      query(`UPDATE broadcast_recipients SET status=$2, error=COALESCE($3, error) WHERE wa_message_id=$1 AND status <> 'read' AND NOT (status='delivered' AND $2='sent')`,
        [s.id, s.status, s.errors?.[0]?.title || null]).catch(() => {});
      query(`UPDATE messages SET status=$2, error=$3 WHERE wa_message_id=$1
               AND status <> 'read' AND NOT (status='delivered' AND $2='sent') RETURNING conversation_id`,
        [s.id, s.status, s.errors?.[0]?.title || null])
        .then(async r => {
          const row = r.rows[0]; if (!row) return;
          const conv = (await query('SELECT assigned_to, company_id FROM conversations WHERE id=$1', [row.conversation_id])).rows[0];
          rt.toConversation(conv || {}, 'message:status', { conversationId: row.conversation_id, waMessageId: s.id, status: s.status });
        })
        .catch(() => {});
    }
  }
});

module.exports = router;
