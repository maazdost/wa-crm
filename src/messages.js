const { query } = require('./db');
const rt = require('./realtime');

async function saveInbound(conv, { waMessageId, type, body, mediaId, mime, filename, referral }) {
  const ins = await query(
    `INSERT INTO messages(conversation_id,direction,sender_type,wa_message_id,type,body,media_id,media_mime,media_name,status)
     VALUES($1,'in','customer',$2,$3,$4,$5,$6,$7,'received')
     ON CONFLICT (wa_message_id) DO NOTHING RETURNING *`,
    [conv.id, waMessageId, type, body, mediaId || null, mime || null, filename || null]);
  if (!ins.rows[0]) return null; // duplicate webhook delivery
  // Click-to-WhatsApp ads give a free 72h window, otherwise the standard 24h
  const hours = referral ? 72 : 24;
  const { rows } = await query(
    `UPDATE conversations SET last_customer_message_at=now(), last_message_at=now(),
       window_expires_at = GREATEST(COALESCE(window_expires_at, now()), now() + ($2 || ' hours')::interval),
       unread_count = unread_count + 1
     WHERE id=$1 RETURNING *`, [conv.id, String(hours)]);
  return { message: ins.rows[0], conversation: rows[0] };
}

async function saveOutbound(conv, { senderType, senderId, body, type = 'text', templateName, waMessageId, status = 'sent', mediaId, mediaMime, mediaName }) {
  const { rows } = await query(
    `INSERT INTO messages(conversation_id,direction,sender_type,sender_id,wa_message_id,type,body,template_name,status,media_id,media_mime,media_name)
     VALUES($1,'out',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [conv.id, senderType, senderId || null, waMessageId, type, body, templateName || null, status, mediaId || null, mediaMime || null, mediaName || null]);
  await query(
    `UPDATE conversations SET last_message_at=now(),
       last_agent_reply_at = CASE WHEN $2='agent' THEN now() ELSE last_agent_reply_at END WHERE id=$1`,
    [conv.id, senderType]);
  const fresh = (await query('SELECT * FROM conversations WHERE id=$1', [conv.id])).rows[0];
  rt.toConversation(fresh, 'message:new', { conversationId: conv.id, message: rows[0] });
  return rows[0];
}

const windowInfo = (c) => ({
  window_open: !!c.window_expires_at && new Date(c.window_expires_at) > new Date(),
  window_expires_at: c.window_expires_at
});

module.exports = { saveInbound, saveOutbound, windowInfo };
