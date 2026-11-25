// Daily summary: every night at the set time the business number sends one WhatsApp message to the numbers
// chosen under Settings > Daily summary: new leads by department, top ad, demo seats, payments, waiting screenshots,
// chats with no reply and the slowest agent. Managers and admins also get it as a phone notification in the app.
// Inside the 24 hour window it goes as a normal message; outside it, the approved template (settings summary.template).
// Off until switched on. Runs every minute (SUMMARY_TICK_MS) for every company that has it switched on.
const { query } = require('./db');
const wa = require('./whatsapp');
const tenant = require('./tenant');
const settings = require('./settings');
const { saveOutbound } = require('./messages');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const toMin = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
function localNow(tz, at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, mins: Number(p.hour) * 60 + Number(p.minute) };
}
const dayLabel = (date) => { const d = new Date(date + 'T00:00:00Z'); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const num = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
/** A phone number as WhatsApp wants it: digits only, with the country code. 03001234567 becomes 923001234567. */
const cleanPhone = (x) => { let d = String(x || '').replace(/\D/g, ''); if (/^0\d{10}$/.test(d)) d = '92' + d.slice(1); if (d.startsWith('00')) d = d.slice(2); return d.length >= 8 && d.length <= 15 ? d : ''; };

/** The numbers for one day (YYYY-MM-DD in the company's time zone). */
async function stats(day, tz) {
  const cid = tenant.cid(), inDay = (col) => `(${col} AT TIME ZONE $2)::date = $3::date`, P = [cid, tz, day];
  const [leads, ad, demo, pay, waiting, noReply, slow] = await Promise.all([
    query(`SELECT COALESCE(d.name, NULLIF(c.team,''), 'Not sorted yet') AS team, COUNT(*)::int AS n FROM contacts ct LEFT JOIN conversations c ON c.contact_id=ct.id
      LEFT JOIN departments d ON d.company_id=ct.company_id AND d.key=c.team WHERE ct.company_id=$1 AND ${inDay('ct.created_at')} AND NOT COALESCE(ct.is_personal,FALSE) GROUP BY 1 ORDER BY 2 DESC`, P),
    query(`SELECT ad_headline AS headline, COUNT(*)::int AS n FROM contacts WHERE company_id=$1 AND ${inDay('created_at')} AND COALESCE(ad_headline,'') <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, P),
    query(`SELECT COUNT(*) FILTER (WHERE ${inDay('created_at')})::int AS booked, COUNT(*) FILTER (WHERE day=$3::date AND status IN ('came','joined'))::int AS came FROM demo_bookings WHERE company_id=$1`, P),
    query(`SELECT currency, COUNT(*)::int AS n, SUM(amount)::float AS total FROM payments WHERE company_id=$1 AND status='confirmed' AND ${inDay('decided_at')} GROUP BY 1 ORDER BY 3 DESC`, P),
    query(`SELECT COUNT(*)::int AS n FROM payments WHERE company_id=$1 AND status='pending'`, [cid]),
    query(`SELECT COUNT(*)::int AS n FROM conversations c WHERE c.company_id=$1 AND c.status='open' AND c.last_customer_message_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.direction='out' AND m.created_at >= c.last_customer_message_at)`, [cid]),
    query(`SELECT u.name, COUNT(*)::int AS n FROM slow_replies s JOIN users u ON u.id=s.agent_id WHERE s.company_id=$1 AND ${inDay('s.created_at')} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, P)
  ]);
  const t = leads.rows.reduce((a, r) => a + r.n, 0);
  return { day, leads: t, byTeam: leads.rows, ad: ad.rows[0] || null, demo: demo.rows[0], payments: pay.rows, paid: pay.rows.reduce((a, r) => a + r.n, 0),
    waiting: waiting.rows[0].n, noReply: noReply.rows[0].n, slow: slow.rows[0] || null };
}
const money = (p) => p.length ? p.map(r => `${r.currency} ${num(r.total)}`).join(' + ') : 'PKR 0';

/** The WhatsApp message (inside the 24 hour window). */
function text(s, company) {
  const L = [`📊 *Daily summary, ${dayLabel(s.day)}*`, company ? `*${company}*` : '', '',
    `👥 New leads: *${s.leads}*`, s.byTeam.length ? '      ' + s.byTeam.map(r => `${r.team} ${r.n}`).join(' · ') : '',
    s.ad ? `📣 Top ad: "${s.ad.headline}" (${s.ad.n} ${s.ad.n === 1 ? 'lead' : 'leads'})` : '',
    `🎓 Demo seats booked: *${s.demo.booked}* · came today: *${s.demo.came}*`,
    `💰 Payments confirmed: *${s.paid}* · ${money(s.payments)}`,
    `🧾 Payment screenshots waiting: *${s.waiting}*`,
    `💬 Chats with no reply: *${s.noReply}*`,
    s.slow ? `🐢 Slowest today: ${s.slow.name} (${s.slow.n} late ${s.slow.n === 1 ? 'reply' : 'replies'})` : ''];
  return L.filter((x, i) => x !== '' || i === 2).join('\n');
}
/** The values for the template: date, leads, demo seats, payments, amount, screenshots waiting, chats with no reply. No line breaks (WhatsApp refuses them in template values). */
const params = (s) => [dayLabel(s.day), String(s.leads), String(s.demo.booked), String(s.paid), money(s.payments), String(s.waiting), String(s.noReply)];
const TEMPLATE = {
  name: 'daily_summary', category: 'UTILITY', language: 'en',
  body: 'Daily summary for {{1}}: {{2}} new leads, {{3}} demo seats booked, {{4}} payments confirmed ({{5}}), {{6}} payment screenshots waiting and {{7}} chats with no reply. Open the app for the details.',
  examples: ['Wed 25 Nov', '14', '5', '2', 'PKR 30,000', '1', '4']
};

/** Sends today's summary (or the given day's) to every number in the settings. Returns { stats, text, results: [{ to, sent, why, how }] } */
async function send({ day = null, s = null } = {}) {
  s = s || await settings.get('summary');
  const tz = s.tz || 'Asia/Karachi', d = day || localNow(tz).date, cid = tenant.cid();
  const st = await stats(d, tz), co = (await query('SELECT name FROM companies WHERE id=$1', [cid])).rows[0] || {};
  const body = text(st, co.name), results = [];
  const t = s.template && (await query('SELECT * FROM templates WHERE company_id=$1 AND name=$2', [cid, s.template])).rows[0];
  for (const to of (Array.isArray(s.numbers) ? s.numbers : []).map(cleanPhone).filter(Boolean)) {
    try {
      const conv = (await query(`SELECT c.* FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.company_id=$1 AND ct.wa_id=$2`, [cid, to])).rows[0];
      const w = conv ? wa.forConversation(conv) : wa.forNumber(null);
      if (conv && conv.last_customer_message_at && new Date(conv.last_customer_message_at) > new Date(Date.now() - 24 * 3600e3)) {
        const r = await w.sendText(to, body);
        await saveOutbound(conv, { senderType: 'bot', body, waMessageId: r.messages?.[0]?.id });
        results.push({ to, sent: true, how: 'message' }); continue;
      }
      if (!t) { results.push({ to, sent: false, why: 'This number has not messaged you in the last 24 hours and the summary template is not set up' }); continue; }
      if (t.status !== 'APPROVED' && process.env.WA_DRY_RUN !== 'true') { results.push({ to, sent: false, why: `This number has not messaged you in the last 24 hours and the template ${t.name} is not approved yet` }); continue; }
      const p = params(st).slice(0, Math.max(0, (t.body.match(/\{\{\d+\}\}/g) || []).length));
      const r = await w.sendTemplate(to, t.name, t.language, p);
      if (conv) await saveOutbound(conv, { senderType: 'bot', type: 'template', templateName: t.name, waMessageId: r.messages?.[0]?.id, body: t.body.replace(/\{\{(\d+)\}\}/g, (_, i) => p[i - 1] ?? '') });
      results.push({ to, sent: true, how: 'template' });
    } catch (e) { results.push({ to, sent: false, why: e.message }); }
  }
  if (s.push !== false) require('./push').notifyManagers(cid, `Daily summary, ${dayLabel(d)}`,
    `${st.leads} new leads, ${st.demo.booked} demo seats, ${st.paid} payments (${money(st.payments)}), ${st.noReply} chats with no reply`, {}, 'message');
  return { stats: st, text: body, results };
}

/** Sends once a day, at or after the set time. The day is written down first, so a restart or two servers never send twice. */
async function checkCompany() {
  const s = await settings.get('summary'); if (!s.enabled) return null;
  const now = localNow(s.tz);
  if (now.mins < toMin(s.time) || s.last_day === now.date) return null;
  const claimed = (await query(`UPDATE settings SET value = value || jsonb_build_object('last_day', $3::text) WHERE company_id=$1 AND key=$2 AND COALESCE(value->>'last_day','') <> $3 RETURNING 1`,
    [tenant.cid(), 'summary', now.date])).rows[0];
  if (!claimed) return null;
  const out = await send({ day: now.date, s });
  const bad = out.results.filter(r => !r.sent);
  if (bad.length) console.warn('[summary] not sent to', bad.map(r => `${r.to}: ${r.why}`).join('; '));
  return out;
}
async function run() {
  const cos = (await query(`SELECT company_id FROM settings WHERE key='summary' AND (value->>'enabled')::boolean IS TRUE`)).rows;
  for (const { company_id } of cos) await tenant.run(company_id, () => checkCompany().catch(e => console.error('daily summary', e.message)));
}
let busy = false;
const start = () => setInterval(async () => { if (busy) return; busy = true; try { await run(); } catch (e) { console.error('daily summary', e.message); } finally { busy = false; } }, Number(process.env.SUMMARY_TICK_MS || 60000));
module.exports = { start, run, send, stats, text, checkCompany, cleanPhone, localNow, TEMPLATE };
