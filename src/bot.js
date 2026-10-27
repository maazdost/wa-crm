const wa = require('./whatsapp');
const { query } = require('./db');
const { assignConversation } = require('./assign');
const rt = require('./realtime');
const push = require('./push');
const settings = require('./settings');
const { saveOutbound } = require('./messages');

// Bot wording is edited by managers in Settings. Teams below decide who receives each kind of client.
const intentsFor = (c) => ({
  info:    { title: c.btnInfo,    team: 'sales',       label: 'More information' },
  team:    { title: c.btnTeam,    team: 'recruitment', label: 'Join the team' },
  classes: { title: c.btnClasses, team: 'classes',     label: 'Classes' },
});
const intentFromText = (t = '') => {
  const s = t.toLowerCase();
  if (/class|course|learn|training/.test(s)) return 'classes';
  if (/team|job|join us|career|work/.test(s)) return 'team';
  return 'info';
};

async function say(conv, text, buttons) {
  const wa_id = (await query('SELECT wa_id FROM contacts WHERE id=$1', [conv.contact_id])).rows[0].wa_id;
  const r = buttons ? await wa.sendButtons(wa_id, text, buttons) : await wa.sendText(wa_id, text);
  await saveOutbound(conv, { senderType: 'bot', body: text, waMessageId: r.messages?.[0]?.id });
}

/** Runs the 3-step bot flow. Returns true if the bot consumed the message. */
async function handle(conv, contact, msg) {
  if (conv.status !== 'bot') return false;
  const cfg = await settings.get('bot'), INTENTS = intentsFor(cfg);

  if (conv.bot_step === 'new') {
    await say(conv, cfg.greet, Object.entries(INTENTS).map(([id, v]) => ({ id, title: v.title })));
    await query(`UPDATE conversations SET bot_step='ask_intent' WHERE id=$1`, [conv.id]);
    return true;
  }
  if (conv.bot_step === 'ask_intent') {
    const intent = INTENTS[msg.buttonId] ? msg.buttonId : intentFromText(msg.body);
    await query(`UPDATE conversations SET intent=$2, team=$3, bot_step='ask_name' WHERE id=$1`, [conv.id, intent, INTENTS[intent].team]);
    await say(conv, cfg.askName);
    return true;
  }
  if (conv.bot_step === 'ask_name') {
    const name = (msg.body || '').trim().slice(0, 60) || 'there';
    await query('UPDATE contacts SET name=$2 WHERE id=$1', [contact.id, name]);
    await say(conv, cfg.handoff.replace(/\{\{\s*name\s*\}\}/gi, name));
    const assigned = await assignConversation(conv.id, conv.team);
    await query(`UPDATE conversations SET bot_step='done' WHERE id=$1`, [conv.id]);
    require('./drip').enroll(contact.id).catch(e => console.error('follow-up enroll', e.message));
    if (assigned) {
      push.notifyUser(assigned.assigned_to, 'New client assigned', `${name}: ${INTENTS[conv.intent]?.label || 'new chat'}`, { conversationId: assigned.id });
      rt.toUser(assigned.assigned_to, 'conversation:assigned', { conversationId: assigned.id, name, intent: conv.intent });
      rt.toConversation(assigned, 'conversation:updated', { conversationId: assigned.id });
    } else {
      rt.toConversation({}, 'conversation:unassigned', { conversationId: conv.id });
    }
    return true;
  }
  return false;
}
module.exports = { handle };
