const wa = require('./whatsapp');
const { query } = require('./db');
const { assignConversation } = require('./assign');
const rt = require('./realtime');
const { saveOutbound } = require('./messages');

// ---- Edit these texts to change what the bot says ----
const TEXT = {
  greet: 'Assalam o Alaikum! Welcome to our trading academy. How can we help you today?',
  askName: 'Great choice! May I know your name please?',
  handoff: (name) => `Thank you ${name}! One of our advisors will message you shortly to guide you personally.`,
};
const INTENTS = {
  info:    { title: 'More info',    team: 'sales',       label: 'More information' },
  team:    { title: 'Join our team', team: 'recruitment', label: 'Join the team' },
  classes: { title: 'Join classes', team: 'classes',     label: 'Classes' },
};
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

  if (conv.bot_step === 'new') {
    await say(conv, TEXT.greet, Object.entries(INTENTS).map(([id, v]) => ({ id, title: v.title })));
    await query(`UPDATE conversations SET bot_step='ask_intent' WHERE id=$1`, [conv.id]);
    return true;
  }

  if (conv.bot_step === 'ask_intent') {
    const intent = INTENTS[msg.buttonId] ? msg.buttonId : intentFromText(msg.body);
    await query(`UPDATE conversations SET intent=$2, team=$3, bot_step='ask_name' WHERE id=$1`,
      [conv.id, intent, INTENTS[intent].team]);
    await say(conv, TEXT.askName);
    return true;
  }

  if (conv.bot_step === 'ask_name') {
    const name = (msg.body || '').trim().slice(0, 60) || 'there';
    await query('UPDATE contacts SET name=$2 WHERE id=$1', [contact.id, name]);
    await say(conv, TEXT.handoff(name));
    const assigned = await assignConversation(conv.id, conv.team);
    await query(`UPDATE conversations SET bot_step='done' WHERE id=$1`, [conv.id]);
    if (assigned) {
      require('./push').notifyUser(assigned.assigned_to, 'New client assigned', `${name}: ${INTENTS[conv.intent]?.label || 'new chat'}`, { conversationId: assigned.id });
      rt.toUser(assigned.assigned_to, 'conversation:assigned', { conversationId: assigned.id, name, intent: conv.intent });
      rt.toConversation(assigned, 'conversation:updated', { conversationId: assigned.id });
    } else {
      rt.toConversation({}, 'conversation:unassigned', { conversationId: conv.id }); // managers see it
    }
    return true;
  }
  return false;
}

module.exports = { handle };
