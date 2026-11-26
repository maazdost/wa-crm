// Chatbots: a flow is a list of steps that the bot walks through with a client.
//   message   - sends a text, a file from the Media Library, or a product
//   buttons   - asks a question with up to 3 buttons; each button leads to its own next step
//   question  - asks an open question and keeps the answer (the name is saved on the contact)
//   action    - adds a tag, sets the department or gives the chat to an agent
//   handover  - says goodbye and hands the chat to the team
// A flow starts for every new client (the welcome flow) or when a client sends one of its keywords.
// While a flow runs, conversations.flow_id and flow_step say where the client is.
// Everything here works only for the company of the current request or job.
const { query } = require('./db');
const tenant = require('./tenant');
const autoreply = require('./autoreply');
const { assignConversation } = require('./assign');

const TYPES = ['message', 'buttons', 'question', 'action', 'handover'];
const KINDS = ['text', 'image', 'video', 'file', 'product'];
const RETRY = 'Please tap one of the buttons above.';
const arr = (x) => Array.isArray(x) ? x : [];
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const btnId = (flow, step, i) => `fl${flow.id}:${step.id}:${i}`;

/** Where a step leads: '' is the step below it, 'end' finishes the flow, anything else is the id of a step. */
const nextIndex = (steps, i, next) => next === 'end' ? -1 : next ? steps.findIndex(s => s.id === next) : i + 1;

const fresh = async (id) => (await query('SELECT * FROM conversations WHERE id=$1', [id])).rows[0];
const openRun = async (conv) => (await query('SELECT * FROM bot_flow_runs WHERE conversation_id=$1 AND flow_id=$2 AND finished_at IS NULL ORDER BY id DESC LIMIT 1', [conv.id, conv.flow_id])).rows[0];

/** The switched-on welcome flow of this company, if it has one. */
const welcome = async () => (await query(`SELECT * FROM bot_flows WHERE company_id=$1 AND active AND trigger='welcome' ORDER BY id DESC LIMIT 1`, [tenant.cid()])).rows[0] || null;

/** The switched-on keyword flow that this message starts, or null. */
async function findKeyword(conv, msg) {
  if (!['text', 'interactive', 'button'].includes(msg.type) || !msg.body) return null;
  if (conv.status === 'bot' && ['ask_intent', 'ask_name'].includes(conv.bot_step)) return null; // the old welcome bot is in the middle of its questions
  const rows = (await query(`SELECT * FROM bot_flows WHERE company_id=$1 AND active AND trigger='keyword' ORDER BY (match_type='exact') DESC, id`, [tenant.cid()])).rows;
  return rows.find(f => autoreply.matches(f, msg.body)) || null;
}

async function sendStep(flow, conv, waId, contact, st) {
  if (st.type === 'message' && st.kind === 'product') {
    const p = (await query('SELECT * FROM products WHERE id=$1 AND company_id=$2', [Number(st.product_id) || 0, tenant.cid()])).rows[0];
    if (p) await require('./catalog').send(conv, waId, p); // a product that was deleted since is skipped
    return;
  }
  if (st.type === 'message' && st.kind !== 'text') {
    const file = (await query('SELECT * FROM media_library WHERE id=$1 AND company_id=$2', [Number(st.media_id) || 0, tenant.cid()])).rows[0];
    return autoreply.sendStep({ id: 0 }, conv, waId, contact, { type: st.kind, text: st.text, buttons: [] }, file);
  }
  const buttons = st.type === 'buttons' ? arr(st.buttons).map(b => ({ type: 'reply', title: b.title })) : [];
  return autoreply.sendStep({ id: 0, btnId: (i) => btnId(flow, st, i) }, conv, waId, contact, { type: 'text', text: st.text, buttons });
}

// Tag, department and agent of an action step. Things that were deleted since are skipped.
async function act(conv, st) {
  const cid = tenant.cid();
  if (st.tag_id) await query('INSERT INTO conversation_labels(conversation_id,label_id) SELECT $1, id FROM labels WHERE id=$2 AND company_id=$3 ON CONFLICT DO NOTHING', [conv.id, st.tag_id, cid]);
  if (st.team) await query('UPDATE conversations SET team=$2 WHERE id=$1 AND EXISTS (SELECT 1 FROM departments WHERE company_id=$3 AND key=$2)', [conv.id, st.team, cid]);
  if (st.assign_to) await query(`UPDATE conversations SET assigned_to=$2, assigned_at=CASE WHEN assigned_to IS DISTINCT FROM $2 THEN now() ELSE assigned_at END
    WHERE id=$1 AND locked_to IS NULL AND EXISTS (SELECT 1 FROM users WHERE id=$2 AND company_id=$3 AND is_active)`, [conv.id, st.assign_to, cid]); // a client kept with an agent stays
}

/** Ends the flow and hands the chat to the team: the agent it already has, else the usual automatic choice. */
async function finish(flow, conv, contact, run, result) {
  const before = await fresh(conv.id), wasNew = before.status === 'bot';
  await query(`UPDATE conversations SET flow_id=NULL, flow_step=NULL, bot_step='done' WHERE id=$1`, [conv.id]);
  const owner = before.assigned_to && (await query('SELECT is_active FROM users WHERE id=$1', [before.assigned_to])).rows[0];
  let next;
  if (owner?.is_active) next = (await query(`UPDATE conversations SET status='open' WHERE id=$1 RETURNING *`, [conv.id])).rows[0];
  else next = (await assignConversation(conv.id, before.team)) || await fresh(conv.id);
  if (run) await query('UPDATE bot_flow_runs SET finished_at=now(), updated_at=now(), result=$2 WHERE id=$1', [run.id, result]);
  if (result === 'done') await query('UPDATE bot_flows SET finished_count = finished_count + 1 WHERE id=$1', [flow.id]);
  if (wasNew) require('./drip').enroll(contact.id).catch(e => console.error('follow-up enroll', e.message));
  return { conversation: next, finished: true, flow, newlyAssigned: !!next.assigned_to && (wasNew || next.assigned_to !== conv.assigned_to) };
}

// Walks the steps from one step on, until the flow has to wait for the client or ends.
async function runFrom(flow, conv, contact, waId, index, run) {
  const steps = arr(flow.steps);
  let i = index, hops = 0;
  while (i >= 0 && i < steps.length && hops++ < 40) { // 40 guards against steps that point at each other in a circle
    const st = steps[i];
    if (st.type === 'action') await act(conv, st);
    else await sendStep(flow, conv, waId, contact, st).catch(e => console.error('chatbot step', e.message));
    if (st.type === 'buttons' || st.type === 'question') {
      await query('UPDATE conversations SET flow_step=$2 WHERE id=$1', [conv.id, st.id]);
      if (run) await query('UPDATE bot_flow_runs SET updated_at=now(), tries=0 WHERE id=$1', [run.id]);
      return { conversation: await fresh(conv.id), finished: false, flow, newlyAssigned: false };
    }
    if (st.type === 'handover') return finish(flow, conv, contact, run, 'done');
    i = nextIndex(steps, i, st.next);
  }
  return finish(flow, conv, contact, run, 'done');
}

/** Starts a flow in a chat. Returns { conversation, finished, newlyAssigned, flow }. */
async function start(flow, conv, contact, waId) {
  const cid = tenant.cid();
  // A closed chat wakes up: with its own agent when that agent is still active, else it waits with the bot until the flow hands it over.
  if (conv.status === 'closed') {
    const owner = conv.assigned_to && (await query('SELECT is_active FROM users WHERE id=$1', [conv.assigned_to])).rows[0];
    await query('UPDATE conversations SET status=$2 WHERE id=$1', [conv.id, owner?.is_active ? 'open' : 'bot']);
  }
  await query(`UPDATE bot_flow_runs SET finished_at=now(), result='restarted' WHERE conversation_id=$1 AND finished_at IS NULL`, [conv.id]);
  conv = (await query(`UPDATE conversations SET flow_id=$2, flow_step=NULL, bot_step=CASE WHEN status='bot' THEN 'flow' ELSE bot_step END WHERE id=$1 RETURNING *`, [conv.id, flow.id])).rows[0];
  await query('UPDATE bot_flows SET started_count = started_count + 1, last_started_at = now() WHERE id=$1', [flow.id]);
  const client = (contact.name || contact.profile_name || '+' + waId).slice(0, 120);
  const run = (await query('INSERT INTO bot_flow_runs(company_id, flow_id, conversation_id, client) VALUES($1,$2,$3,$4) RETURNING *', [cid, flow.id, conv.id, client])).rows[0];
  query(`DELETE FROM bot_flow_runs WHERE company_id=$1 AND started_at < now() - interval '90 days'`, [cid]).catch(() => {});
  return runFrom(flow, conv, contact, waId, 0, run);
}

/**
 * The client answered while a flow is waiting. Returns null when no flow is waiting in this chat
 * (also when the flow was switched off, deleted, or left alone for more than a day), so the usual handling goes on.
 */
async function reply(conv, contact, msg, waId) {
  if (!conv.flow_id) return null;
  const stop = async (run, result) => {
    await query(`UPDATE conversations SET flow_id=NULL, flow_step=NULL, bot_step=CASE WHEN bot_step='flow' THEN 'new' ELSE bot_step END WHERE id=$1`, [conv.id]);
    if (run) await query('UPDATE bot_flow_runs SET finished_at=now(), result=$2 WHERE id=$1', [run.id, result]);
    Object.assign(conv, await fresh(conv.id));
    return null;
  };
  const flow = (await query('SELECT * FROM bot_flows WHERE id=$1 AND company_id=$2', [conv.flow_id, tenant.cid()])).rows[0];
  const run = await openRun(conv);
  if (!flow || !flow.active) return stop(run, 'switched_off');
  if (run && Date.now() - new Date(run.updated_at).getTime() > 24 * 3600 * 1000) return stop(run, 'expired');
  const steps = arr(flow.steps), i = steps.findIndex(s => s.id === conv.flow_step), st = steps[i];
  if (!st) return stop(run, 'changed');

  if (st.type === 'question') {
    const answer = (msg.body || '').trim().slice(0, 300) || `[${msg.type}]`;
    if (st.save === 'name') {
      const name = answer.slice(0, 60);
      await query('UPDATE contacts SET name=$2 WHERE id=$1', [contact.id, name]); contact.name = name;
      if (run) await query('UPDATE bot_flow_runs SET client=$2 WHERE id=$1', [run.id, name]);
    }
    const label = st.save === 'name' ? 'Name' : (st.label || 'Answer');
    if (run) await query('UPDATE bot_flow_runs SET answers = answers || $2::jsonb, updated_at=now() WHERE id=$1', [run.id, JSON.stringify({ [label]: answer })]);
    return runFrom(flow, conv, contact, waId, nextIndex(steps, i, st.next), run);
  }
  // A question with buttons: the tap, the button's words typed out, or its number (1, 2, 3)
  const buttons = arr(st.buttons), tap = /^fl\d+:/.test(msg.buttonId || '') ? msg.buttonId : '';
  let b = tap ? buttons.findIndex((_, j) => btnId(flow, st, j) === tap) : -1;
  if (b < 0) b = buttons.findIndex(x => norm(x.title) === norm(msg.body));
  if (b < 0 && /^[1-3]$/.test((msg.body || '').trim())) b = Number(msg.body.trim()) - 1 < buttons.length ? Number(msg.body.trim()) - 1 : -1;
  if (b < 0) b = wordMatch(buttons, msg.body); // "classes kab hain?" picks the Classes button

  if (b >= 0) {
    if (run) await query('UPDATE bot_flow_runs SET answers = answers || $2::jsonb, updated_at=now() WHERE id=$1', [run.id, JSON.stringify({ [String(st.text || '').slice(0, 60)]: buttons[b].title })]);
    return runFrom(flow, conv, contact, waId, nextIndex(steps, i, buttons[b].next), run);
  }
  // Something else was typed (a question, a voice note...): a person answers it straight away instead of the bot asking again,
  // so a client who does not like buttons is never lost.
  if (run) await query('UPDATE bot_flow_runs SET answers = answers || $2::jsonb, updated_at=now() WHERE id=$1', [run.id, JSON.stringify({ 'Typed instead': (msg.body || `[${msg.type}]`).slice(0, 300) })]);
  return finish(flow, conv, contact, run, 'no_answer');
}

// The meaningful words of a button title ("📚 Forex Classes" -> forex, classes), for clients who type instead of tapping.
const words = (t) => norm(t).replace(/[^\p{L}\p{N} ]/gu, ' ').split(' ').filter(w => w.length >= 4);
function wordMatch(buttons, text) {
  const said = new Set(words(text)); if (!said.size) return -1;
  const hits = buttons.map((x, j) => words(x.title).some(w => said.has(w) || said.has(w.replace(/s$/, ''))) ? j : -1).filter(j => j >= 0);
  return hits.length === 1 ? hits[0] : -1; // only when exactly one button fits
}

const WAIT_MIN = () => Math.max(1, Number(process.env.FLOW_WAIT_MINUTES) || 5);
/**
 * A client who has not answered the chatbot for a few minutes (FLOW_WAIT_MINUTES, 5 by default) is handed to the team,
 * so an agent sees the chat and the number and can write to them. Returns the hand overs that were made.
 */
async function sweep() {
  const due = (await query(`SELECT r.id AS run_id, r.company_id, r.conversation_id FROM bot_flow_runs r JOIN conversations c ON c.id=r.conversation_id AND c.flow_id=r.flow_id
    WHERE r.finished_at IS NULL AND c.flow_step IS NOT NULL AND r.updated_at < now() - ($1 || ' minutes')::interval ORDER BY r.id LIMIT 20`, [String(WAIT_MIN())])).rows;
  const out = [];
  for (const d of due) await tenant.run(d.company_id, async () => {
    try {
      const conv = await fresh(d.conversation_id), flow = (await query('SELECT * FROM bot_flows WHERE id=$1', [conv.flow_id])).rows[0];
      const contact = (await query('SELECT * FROM contacts WHERE id=$1', [conv.contact_id])).rows[0];
      const run = (await query('SELECT * FROM bot_flow_runs WHERE id=$1', [d.run_id])).rows[0];
      if (!flow || !contact) { await query(`UPDATE bot_flow_runs SET finished_at=now(), result='changed' WHERE id=$1`, [d.run_id]); return; }
      const r = await finish(flow, conv, contact, run, 'no_answer');
      out.push(r); tellTeam(r, contact);
    } catch (e) { console.error('chatbot wait', e.message); }
  });
  return out;
}
// Lets the team know about a chat the bot handed over by itself.
function tellTeam(r, contact) {
  const rt = require('./realtime'), push = require('./push'), c = r.conversation, who = contact.name || contact.profile_name || '+' + contact.wa_id;
  if (c.assigned_to) {
    push.notifyUser(c.assigned_to, 'New client assigned', `${who}: did not answer the chatbot`, { conversationId: c.id }, 'assigned');
    rt.toUser(c.assigned_to, 'conversation:assigned', { conversationId: c.id, name: who });
    rt.toConversation(c, 'conversation:updated', { conversationId: c.id });
  } else rt.toConversation({}, 'conversation:unassigned', { conversationId: c.id });
}
let busy = false;
const startSweep = () => setInterval(async () => { if (busy) return; busy = true; try { await sweep(); } catch (e) { console.error('chatbot wait', e.message); } finally { busy = false; } }, Number(process.env.FLOW_SWEEP_MS || 60000));

/** An agent wrote in the chat: the bot steps back. */
async function agentTookOver(convId) {
  const c = (await query(`UPDATE conversations SET flow_id=NULL, flow_step=NULL, bot_step=CASE WHEN bot_step='flow' THEN 'done' ELSE bot_step END WHERE id=$1 AND flow_id IS NOT NULL RETURNING id`, [convId])).rows[0];
  if (c) await query(`UPDATE bot_flow_runs SET finished_at=now(), result='agent' WHERE conversation_id=$1 AND finished_at IS NULL`, [convId]);
}

/** The welcome chatbot's opening messages (its message steps before the first question, buttons or hand over), sent on their own.
 *  Used for clients from an ad: they get the greeting and links, then go straight to an agent without the menu. */
async function sendGreeting(conv, contact, waId) {
  const flow = await welcome(); if (!flow) return 0;
  const steps = arr(flow.steps); let i = 0, sent = 0, hops = 0;
  while (i >= 0 && i < steps.length && hops++ < 10 && steps[i].type === 'message') {
    await sendStep(flow, conv, waId, contact, steps[i]).catch(e => console.error('ad greeting', e.message)); sent++;
    i = nextIndex(steps, i, steps[i].next);
  }
  return sent;
}

module.exports = { TYPES, KINDS, RETRY, welcome, findKeyword, start, reply, agentTookOver, nextIndex, sweep, startSweep, sendGreeting };
