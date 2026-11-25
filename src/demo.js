// Demo class bookings: a client books a free demo seat in the chat (place, then day), gets reminders on the day,
// and after the class gets a "join the course" or "book the next demo" message when the team marks Came or Didn't come.
// Set up per company on the Demo Classes page (settings key 'demo'). Off until a manager switches it on.
// Everything here works only for the company of the current request or job.
const { query } = require('./db');
const wa = require('./whatsapp');
const tenant = require('./tenant');
const settings = require('./settings');
const autoreply = require('./autoreply');
const { saveOutbound } = require('./messages');
const { assignConversation } = require('./assign');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const toMin = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const pad = (n) => String(n).padStart(2, '0');
// A date from the database (a Date at local midnight) or text, as YYYY-MM-DD
const isoDay = (d) => d instanceof Date ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : String(d).slice(0, 10);

/** Today's date, weekday and minutes since midnight in the company's time zone. */
function localNow(tz, at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map(x => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, dow: new Date(date + 'T00:00:00Z').getUTCDay(), mins: Number(p.hour) * 60 + Number(p.minute) };
}
const addDays = (date, n) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** "Fri 28 Nov" */
const dayLabel = (date) => { const d = new Date(isoDay(date) + 'T00:00:00Z'); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
/** "7:00 PM" */
const timeLabel = (t) => { const m = toMin(t), h = Math.floor(m / 60) % 24; return `${h % 12 || 12}:${pad(m % 60)} ${h < 12 ? 'AM' : 'PM'}`; };

const cfg = () => settings.get('demo');
const placeOf = (s, key) => (s.places || []).find(p => p.key === key);

/** Seats taken for one class. */
async function taken(day, place) {
  return (await query(`SELECT COUNT(*)::int AS n FROM demo_bookings WHERE company_id=$1 AND day=$2 AND place=$3 AND status IN ('booked','came','joined')`, [tenant.cid(), day, place])).rows[0].n;
}

/** The next classes that can still be booked: [{ day, place, name, time, seats, booked, left, link }] for the next two weeks. */
async function upcoming(s, { place = null, limit = 20 } = {}) {
  const now = localNow(s.tz), out = [];
  const links = (await query(`SELECT to_char(day,'YYYY-MM-DD') AS day, place, link FROM demo_sessions WHERE company_id=$1 AND day >= $2`, [tenant.cid(), now.date])).rows;
  for (let i = 0; i < 14 && out.length < limit; i++) {
    const day = addDays(now.date, i), dow = new Date(day + 'T00:00:00Z').getUTCDay();
    if (!(s.days || []).includes(dow)) continue;
    for (const p of s.places || []) {
      if (place && p.key !== place) continue;
      if (i === 0 && now.mins >= toMin(p.time)) continue; // today's class has started
      const booked = await taken(day, p.key), seats = Number(p.seats) || 0;
      out.push({ day, place: p.key, name: p.name, time: p.time, seats, booked, left: seats ? Math.max(0, seats - booked) : null, link: (links.find(l => l.day === day && l.place === p.key) || {}).link || '' });
    }
  }
  return out;
}

/** {{first_name}}, {{name}}, {{place}}, {{date}}, {{time}}, {{info}} and {{link}} in a demo message. */
function fill(text, contact, b, s, link) {
  const p = (b && placeOf(s, b.place)) || {};
  const v = { place: p.name || '', date: b ? dayLabel(b.day) : '', time: p.time ? timeLabel(p.time) : '', link: link || '', info: link || p.info || '' };
  return autoreply.fill(String(text || '').replace(/\{\{\s*(place|date|time|info|link)\s*\}\}/gi, (_, k) => v[k.toLowerCase()]), contact).replace(/[ \t]+\n/g, '\n').trim();
}

const windowOpen = (conv) => conv.last_customer_message_at && new Date(conv.last_customer_message_at) > new Date(Date.now() - 24 * 3600e3);

/**
 * Sends a demo message into the chat. Inside the 24 hour window it is plain text (with buttons if given).
 * Outside it, the approved template set on the Demo Classes page is used: {{1}} first name, {{2}} day, time and place, {{3}} link or address.
 * Returns { sent: true } or { sent: false, why }.
 */
async function send(conv, contact, text, { buttons = [], b = null, s = null, link = '' } = {}) {
  s = s || await cfg();
  const waId = contact.wa_id, w = wa.forConversation(conv);
  if (contact.opted_out || contact.is_personal) return { sent: false, why: 'The client opted out of messages' };
  if (windowOpen(conv)) {
    await autoreply.sendStep({ id: 0, btnId: (i) => buttons[i].id }, conv, waId, contact, { type: 'text', text, buttons });
    return { sent: true };
  }
  const t = s.template && (await query('SELECT * FROM templates WHERE name=$1 AND company_id=$2', [s.template, tenant.cid()])).rows[0];
  if (!t) return { sent: false, why: 'The 24 hour window is closed and no reminder template is set' };
  if (t.status !== 'APPROVED' && process.env.WA_DRY_RUN !== 'true') return { sent: false, why: `The template ${t.name} is not approved yet` };
  const p = (b && placeOf(s, b.place)) || {};
  const first = ((contact.name || contact.profile_name || '').trim().split(/\s+/)[0]) || 'there';
  const params = [first, b ? `${dayLabel(b.day)}, ${timeLabel(p.time)}, ${p.name || ''}` : '', link || p.info || '-'].slice(0, Math.max(0, (t.body.match(/\{\{\d+\}\}/g) || []).length));
  const sent = await w.sendTemplate(waId, t.name, t.language, params);
  await saveOutbound(conv, { senderType: 'bot', type: 'template', templateName: t.name, waMessageId: sent.messages?.[0]?.id, body: t.body.replace(/\{\{(\d+)\}\}/g, (_, i) => params[i - 1] ?? '') });
  return { sent: true };
}

const LABEL = 'Demo booked';
async function tag(convId) {
  const l = (await query(`INSERT INTO labels(company_id,name,color) VALUES($1,$2,'#b7791f') ON CONFLICT (company_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [tenant.cid(), LABEL])).rows[0];
  await query('INSERT INTO conversation_labels(conversation_id,label_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [convId, l.id]);
}

/**
 * Books a seat. Any other booking of this client that has not happened yet is moved to the new one.
 * Returns { booking } or { error }.
 */
async function book({ conv, day, place, by = null }) {
  const s = await cfg(), p = placeOf(s, place);
  if (!p) return { error: 'Choose a place' };
  const ok = (await upcoming(s, { place })).find(x => x.day === day);
  if (!ok) return { error: 'This class is not open for booking' };
  const mine = (await query(`SELECT * FROM demo_bookings WHERE company_id=$1 AND contact_id=$2 AND status='booked' AND day >= $3`, [tenant.cid(), conv.contact_id, localNow(s.tz).date])).rows;
  const same = mine.find(x => isoDay(x.day) === day && x.place === place);
  if (same) return { booking: same, already: true };
  if (ok.seats && ok.left <= 0) return { error: 'This class is full', full: true };
  if (mine.length) await query(`UPDATE demo_bookings SET status='moved', updated_at=now() WHERE id = ANY($1::int[])`, [mine.map(x => x.id)]);
  const b = (await query(`INSERT INTO demo_bookings(company_id, contact_id, conversation_id, day, place, booked_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [tenant.cid(), conv.contact_id, conv.id, day, place, by])).rows[0];
  await tag(conv.id).catch(e => console.error('demo tag', e.message));
  return { booking: b, moved: mine.length > 0 };
}

/** A new chat that asks for a demo goes to the demo department (or keeps its agent), like a finished chatbot. */
async function route(conv, contact, s) {
  if (conv.status !== 'bot') return { conversation: conv, newlyAssigned: false };
  await query(`UPDATE conversations SET team=CASE WHEN $2 <> '' AND EXISTS (SELECT 1 FROM departments WHERE company_id=$3 AND key=$2) THEN $2 ELSE team END, bot_step='done' WHERE id=$1`, [conv.id, s.team || '', tenant.cid()]);
  let next = (await query('SELECT * FROM conversations WHERE id=$1', [conv.id])).rows[0];
  const owner = next.assigned_to && (await query('SELECT is_active FROM users WHERE id=$1', [next.assigned_to])).rows[0];
  if (owner?.is_active) next = (await query(`UPDATE conversations SET status='open' WHERE id=$1 RETURNING *`, [conv.id])).rows[0];
  else next = (await assignConversation(conv.id, next.team)) || (await query('SELECT * FROM conversations WHERE id=$1', [conv.id])).rows[0];
  require('./drip').enroll(contact.id).catch(e => console.error('follow-up enroll', e.message));
  return { conversation: next, newlyAssigned: !!next.assigned_to };
}

const cut = (s, n = 20) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
async function offerPlaces(conv, contact, s) {
  const open = await upcoming(s);
  const places = (s.places || []).filter(p => open.some(o => o.place === p.key && (!o.seats || o.left > 0))).slice(0, 3);
  if (!places.length) return send(conv, contact, fill(s.none, contact, null, s), { s });
  if (places.length === 1) return offerDays(conv, contact, s, places[0].key);
  return send(conv, contact, fill(s.ask, contact, null, s), { s, buttons: places.map(p => ({ id: `demo:p:${p.key}`, title: cut(p.name) })) });
}
async function offerDays(conv, contact, s, place) {
  const days = (await upcoming(s, { place })).filter(o => !o.seats || o.left > 0).slice(0, 3);
  if (!days.length) return send(conv, contact, fill(s.none, contact, null, s), { s });
  const p = placeOf(s, place);
  return send(conv, contact, fill(s.pick_day, contact, { place, day: days[0].day }, s), { s, buttons: days.map(d => ({ id: `demo:d:${place}:${d.day}`, title: cut(`${dayLabel(d.day)} ${timeLabel(p.time)}`) })) });
}

/**
 * Incoming message: a tap on a demo button, or a message with one of the demo words.
 * Returns the same shape as a chatbot ({ conversation, finished, flow, newlyAssigned }) or null when it is not about the demo.
 */
async function handle(conv, contact, msg) {
  const s = await cfg(); if (!s.enabled) return null;
  const id = String(msg.buttonId || '');
  const words = id.startsWith('demo:') ? null : (Array.isArray(s.words) ? s.words : []);
  if (!id.startsWith('demo:')) {
    if (msg.type !== 'text' || !msg.body || !words.length) return null;
    if (conv.status === 'bot' && ['ask_intent', 'ask_name'].includes(conv.bot_step)) return null;
    if (!autoreply.matches({ keywords: words, match_type: 'contains' }, msg.body)) return null;
  }
  const r = await route(conv, contact, s); conv = r.conversation;
  const done = { conversation: conv, finished: true, flow: { name: 'Demo class' }, newlyAssigned: r.newlyAssigned };
  const [, kind, place, day] = id.split(':');
  if (kind === 'p') { await offerDays(conv, contact, s, place); return done; }
  if (kind === 'd') {
    const out = await book({ conv, day, place });
    if (out.error) { await send(conv, contact, fill(s.full, contact, null, s), { s }); await offerPlaces(conv, contact, s); return done; }
    await send(conv, contact, fill(s.booked, contact, out.booking, s), { s, b: out.booking });
    return { ...done, flow: { name: `Demo booked: ${(placeOf(s, place) || {}).name || place}, ${dayLabel(day)}` } };
  }
  await offerPlaces(conv, contact, s);
  return done;
}

/** Marks a booking Came, Didn't come, Joined or Cancelled. Came and Didn't come send the after-class message. */
async function mark(b, status) {
  const s = await cfg();
  const row = (await query(`UPDATE demo_bookings SET status=$2, updated_at=now() WHERE id=$1 RETURNING *`, [b.id, status])).rows[0];
  if (!['came', 'missed'].includes(status) || b.after_sent) return { booking: row, sent: null };
  const conv = (await query('SELECT * FROM conversations WHERE id=$1', [b.conversation_id])).rows[0];
  const contact = (await query('SELECT * FROM contacts WHERE id=$1', [b.contact_id])).rows[0];
  if (!conv || !contact) return { booking: row, sent: null };
  const text = fill(status === 'came' ? s.came : s.missed, contact, b, s);
  if (!text) return { booking: row, sent: null };
  const out = await send(conv, contact, text, { s, b }).catch(e => ({ sent: false, why: e.message }));
  if (out.sent) await query('UPDATE demo_bookings SET after_sent=TRUE WHERE id=$1', [b.id]);
  if (out.sent && status === 'missed' && windowOpen(conv)) await offerPlaces(conv, contact, s).catch(() => {});
  return { booking: row, sent: out };
}

/** Reminders for today's classes: one in the morning and one shortly before. Each is claimed first, so it never goes twice. */
async function remindCompany() {
  const s = await cfg(); if (!s.enabled) return [];
  const now = localNow(s.tz), done = [];
  const rows = (await query(`SELECT b.*, to_char(b.day,'YYYY-MM-DD') AS d FROM demo_bookings b WHERE b.company_id=$1 AND b.status='booked' AND b.day=$2 AND (b.morning_at IS NULL OR b.hour_at IS NULL)`, [tenant.cid(), now.date])).rows;
  for (const b of rows) {
    const p = placeOf(s, b.place); if (!p) continue;
    const start = toMin(p.time); if (now.mins >= start) continue;
    let kind = null;
    if (!b.hour_at && now.mins >= start - (Number(s.before) || 60)) kind = 'hour';
    else if (!b.morning_at && now.mins >= toMin(s.morning)) kind = 'morning';
    if (!kind) continue;
    const col = kind === 'hour' ? 'hour_at' : 'morning_at';
    // the hour reminder also covers the morning one when the client booked late in the day
    const claimed = (await query(`UPDATE demo_bookings SET ${col}=now()${kind === 'hour' ? ', morning_at=COALESCE(morning_at, now())' : ''} WHERE id=$1 AND ${col} IS NULL RETURNING id`, [b.id])).rows[0];
    if (!claimed) continue;
    const conv = (await query('SELECT * FROM conversations WHERE id=$1', [b.conversation_id])).rows[0];
    const contact = (await query('SELECT * FROM contacts WHERE id=$1', [b.contact_id])).rows[0];
    if (!conv || !contact) continue;
    const link = ((await query('SELECT link FROM demo_sessions WHERE company_id=$1 AND day=$2 AND place=$3', [tenant.cid(), b.d, b.place])).rows[0] || {}).link || '';
    const bb = { ...b, day: b.d };
    const out = await send(conv, contact, fill(kind === 'hour' ? s.remind_hour : s.remind_morning, contact, bb, s, link), { s, b: bb, link }).catch(e => ({ sent: false, why: e.message }));
    if (!out.sent) await query('UPDATE demo_bookings SET remind_error=$2 WHERE id=$1', [b.id, out.why]);
    else await query('UPDATE demo_bookings SET remind_error=NULL WHERE id=$1', [b.id]);
    done.push({ id: b.id, kind, sent: out.sent });
    require('./realtime').toConversation(conv, 'conversation:updated', { conversationId: conv.id });
  }
  return done;
}
async function run() {
  const cos = (await query(`SELECT company_id FROM settings WHERE key='demo' AND (value->>'enabled')::boolean IS TRUE`)).rows;
  for (const { company_id } of cos) await tenant.run(company_id, () => remindCompany().catch(e => console.error('demo reminders', e.message)));
}
let busy = false;
const start = () => setInterval(async () => { if (busy) return; busy = true; try { await run(); } catch (e) { console.error('demo reminders', e.message); } finally { busy = false; } }, Number(process.env.DEMO_TICK_MS || 60000));

const fillBooked = (contact, b, s) => fill(s.booked, contact, { ...b, day: isoDay(b.day) }, s);
const sendText = (conv, contact, text, s, b) => send(conv, contact, text, { s, b: { ...b, day: isoDay(b.day) } });
module.exports = { fillBooked, sendText, handle, book, mark, upcoming, localNow, dayLabel, timeLabel, isoDay, run, remindCompany, start, placeOf, cfg };
