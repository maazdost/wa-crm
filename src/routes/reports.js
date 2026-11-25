// Reports (numbers for any date range, exported from the page as CSV) and Health Audit (is the WhatsApp setup healthy?).
// Read-only: nothing here changes data.
const express = require('express');
const { query } = require('../db');
const { required } = require('../auth');
const wa = require('../whatsapp');
const numbers = require('../numbers');
const settings = require('../settings');
const tenant = require('../tenant');
const C = () => tenant.cid(); // the signed-in person's company; every query below is limited to it
const router = express.Router();
const mgr = required('admin', 'manager');
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });
const TZ = () => process.env.REPORT_TZ || 'Asia/Karachi';
const DRY = () => process.env.WA_DRY_RUN === 'true';
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));
const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;

// ---- Reports ----
// GET /reports?from=2026-11-01&to=2026-11-30  (days in the report time zone, both included, at most 366 days; default: the last 30 days)
router.get('/reports', mgr, wrap(async (req, res) => {
  const tz = TZ(), cid = C();
  const today = (await query(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [tz])).rows[0].d;
  let to = isDay(req.query.to) ? req.query.to : today, from = isDay(req.query.from) ? req.query.from : null;
  if (!from) from = new Date(Date.parse(to) - 29 * 864e5).toISOString().slice(0, 10);
  if (from > to) [from, to] = [to, from];
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 366) return res.status(400).json({ error: 'Choose a range of one year or less' });
  const P = [from, to, tz, cid];
  // "col" falls inside the chosen days, counted in the report time zone
  const R = (col) => `${col} >= ($1::date)::timestamp AT TIME ZONE $3 AND ${col} < ($1::date + ($2::date - $1::date) + 1)::timestamp AT TIME ZONE $3`;
  const FIRST_REPLY = `(SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id=c.id AND m.sender_type='agent' AND m.created_at >= c.assigned_at)`;

  const [sum, msg, med, daily, agents, hours, intents, sources, tags, bcs, quick] = await Promise.all([
    query(`SELECT (SELECT COUNT(*) FROM conversations c WHERE c.company_id=$4 AND ${R('c.created_at')})::int AS new_chats,
                  (SELECT COUNT(*) FROM contacts ct WHERE ct.company_id=$4 AND ${R('ct.created_at')})::int AS new_contacts,
                  (SELECT COUNT(*) FROM conversations c WHERE c.company_id=$4 AND ${R('c.assigned_at')})::int AS assigned,
                  (SELECT COUNT(*) FROM contacts ct WHERE ct.company_id=$4 AND ct.opted_out)::int AS opted_out_now`, P),
    query(`SELECT COUNT(*) FILTER (WHERE m.direction='in')::int AS inbound,
                  COUNT(*) FILTER (WHERE m.sender_type='agent')::int AS agent_out,
                  COUNT(*) FILTER (WHERE m.sender_type='bot')::int AS bot_out,
                  COUNT(*) FILTER (WHERE m.direction='out' AND m.type='template')::int AS template_out,
                  COUNT(*) FILTER (WHERE m.direction='out')::int AS outbound,
                  COUNT(*) FILTER (WHERE m.direction='out' AND m.status IN ('delivered','read'))::int AS delivered,
                  COUNT(*) FILTER (WHERE m.direction='out' AND m.status='read')::int AS read,
                  COUNT(*) FILTER (WHERE m.direction='out' AND m.status='failed')::int AS failed
             FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.company_id=$4 AND ${R('m.created_at')}`, P),
    query(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (fr - assigned_at))) AS sec FROM (
             SELECT c.assigned_at, ${FIRST_REPLY} AS fr FROM conversations c WHERE c.company_id=$4 AND ${R('c.assigned_at')}) t WHERE fr IS NOT NULL`, P),
    query(`SELECT to_char(g, 'YYYY-MM-DD') AS day, COALESCE(cv.n,0)::int AS new_chats, COALESCE(ms.inbound,0)::int AS inbound,
                  COALESCE(ms.agent_out,0)::int AS agent_out, COALESCE(ms.bot_out,0)::int AS bot_out, COALESCE(ms.failed,0)::int AS failed
             FROM generate_series($1::date::timestamp, $2::date::timestamp, interval '1 day') g
             LEFT JOIN (SELECT (c.created_at AT TIME ZONE $3)::date AS d, COUNT(*) AS n FROM conversations c WHERE c.company_id=$4 AND ${R('c.created_at')} GROUP BY 1) cv ON cv.d = g::date
             LEFT JOIN (SELECT (m.created_at AT TIME ZONE $3)::date AS d, COUNT(*) FILTER (WHERE m.direction='in') AS inbound, COUNT(*) FILTER (WHERE m.sender_type='agent') AS agent_out,
                               COUNT(*) FILTER (WHERE m.sender_type='bot') AS bot_out, COUNT(*) FILTER (WHERE m.direction='out' AND m.status='failed') AS failed
                          FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.company_id=$4 AND ${R('m.created_at')} GROUP BY 1) ms ON ms.d = g::date
            ORDER BY g`, P),
    query(`SELECT u.id, u.name, u.team, u.is_active, COUNT(c.id)::int AS assigned, COUNT(c.fr)::int AS replied,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (c.fr - c.assigned_at))) AS median_reply_sec,
                  (SELECT COUNT(*) FROM messages m WHERE m.sender_id=u.id AND m.sender_type='agent' AND ${R('m.created_at')})::int AS msgs_sent,
                  (SELECT COUNT(*) FROM conversations o WHERE o.assigned_to=u.id AND o.status='open')::int AS open_now,
                  (SELECT COUNT(*) FROM conversations o WHERE o.assigned_to=u.id AND o.status='closed')::int AS closed_now
             FROM users u LEFT JOIN LATERAL (SELECT c.id, c.assigned_at, ${FIRST_REPLY} AS fr FROM conversations c WHERE c.assigned_to=u.id AND ${R('c.assigned_at')}) c ON TRUE
            WHERE u.company_id=$4 AND (u.role='agent' OR u.in_rotation) GROUP BY u.id HAVING u.is_active OR COUNT(c.id) > 0 ORDER BY assigned DESC, u.name`, P),
    query(`SELECT EXTRACT(HOUR FROM m.created_at AT TIME ZONE $3)::int AS hour, COUNT(*)::int AS n
             FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.company_id=$4 AND m.direction='in' AND ${R('m.created_at')} GROUP BY 1 ORDER BY 1`, P),
    query(`SELECT COALESCE(c.intent,'unknown') AS k, COUNT(*)::int AS n FROM conversations c WHERE c.company_id=$4 AND ${R('c.created_at')} GROUP BY 1 ORDER BY n DESC`, P),
    query(`SELECT COALESCE(ct.source,'organic') AS k, COUNT(*)::int AS n FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.company_id=$4 AND ${R('c.created_at')} GROUP BY 1 ORDER BY n DESC`, P),
    query(`SELECT l.name, l.color, COUNT(*)::int AS n FROM conversation_labels cl JOIN labels l ON l.id=cl.label_id JOIN conversations c ON c.id=cl.conversation_id
            WHERE c.company_id=$4 AND ${R('c.last_message_at')} GROUP BY l.id ORDER BY n DESC LIMIT 20`, P),
    query(`SELECT b.id, b.name, b.template_name, b.status, to_char(b.scheduled_at AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS at,
                  COUNT(r.id)::int AS total, COUNT(r.id) FILTER (WHERE r.status IN ('sent','delivered','read'))::int AS sent,
                  COUNT(r.id) FILTER (WHERE r.status IN ('delivered','read'))::int AS delivered, COUNT(r.id) FILTER (WHERE r.status='read')::int AS read,
                  COUNT(r.id) FILTER (WHERE r.status='failed')::int AS failed
             FROM broadcasts b LEFT JOIN broadcast_recipients r ON r.broadcast_id=b.id WHERE b.company_id=$4 AND ${R('b.scheduled_at')} GROUP BY b.id ORDER BY b.scheduled_at DESC LIMIT 100`, P),
    query(`SELECT name, active, sent_count, to_char(last_sent_at AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS last_sent FROM auto_replies WHERE company_id=$2 ORDER BY sent_count DESC, name LIMIT 50`, [tz, cid])
  ]);
  const m = msg.rows[0];
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, n: (hours.rows.find(x => x.hour === h) || {}).n || 0 }));
  res.json({ from, to, tz, summary: { ...sum.rows[0], ...m, median_reply_sec: med.rows[0].sec, delivered_pct: pct(m.delivered, m.outbound), read_pct: pct(m.read, m.outbound), failed_pct: pct(m.failed, m.outbound) },
    daily: daily.rows, agents: agents.rows, hours: byHour, intents: intents.rows, sources: sources.rows, tags: tags.rows, broadcasts: bcs.rows, quick: quick.rows });
}));

// ---- Health Audit ----
// One check = { level: ok | warn | bad | info, area, title, detail, fix }. The page shows them as a list with a score.
const TIERS = { TIER_50: '50', TIER_250: '250', TIER_1K: '1,000', TIER_2K: '2,000', TIER_10K: '10,000', TIER_100K: '100,000', TIER_UNLIMITED: 'Unlimited' };
async function numberHealth(n) {
  const out = { id: n.id, label: n.label, display_phone: n.display_phone, is_default: n.is_default, reachable: null };
  if (DRY()) return { ...out, test_mode: true };
  let w; try { w = wa.forNumber(n.id); } catch (e) { return { ...out, reachable: false, error: e.message }; }
  try {
    const d = await w.graph(`${n.phone_number_id}?fields=display_phone_number,verified_name,quality_rating`);
    Object.assign(out, { reachable: true, display_phone: d.display_phone_number || out.display_phone, verified_name: d.verified_name, quality: d.quality_rating || 'UNKNOWN' });
  } catch (e) { return { ...out, reachable: false, error: e.message }; }
  // Extra details. Not every account returns them, so a refusal here is not an error.
  try {
    const x = await w.graph(`${n.phone_number_id}?fields=messaging_limit_tier,name_status,code_verification_status,status`);
    Object.assign(out, { limit: TIERS[x.messaging_limit_tier] || x.messaging_limit_tier || null, name_status: x.name_status || null, connection: x.status || null });
  } catch { /* shown as unknown */ }
  return out;
}

router.get('/health-audit', mgr, wrap(async (req, res) => {
  const cid = C(), checks = [], add = (level, area, title, detail, fix) => checks.push({ level, area, title, detail, fix: fix || null });
  const list = await numbers.list();
  const nums = await Promise.all(list.map(numberHealth));
  const q = async (sql, p = [cid]) => (await query(sql, p)).rows;
  const [d7] = await q(`SELECT COUNT(*)::int AS outbound, COUNT(*) FILTER (WHERE m.status IN ('delivered','read'))::int AS delivered,
        COUNT(*) FILTER (WHERE m.status='read')::int AS read, COUNT(*) FILTER (WHERE m.status='failed')::int AS failed
      FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.company_id=$1 AND m.direction='out' AND m.created_at > now() - interval '7 days'`);
  const errors = await q(`SELECT m.error AS reason, COUNT(*)::int AS n, to_char(MAX(m.created_at) AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS last
      FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.company_id=$1 AND m.status='failed' AND m.error IS NOT NULL AND m.created_at > now() - interval '30 days'
      GROUP BY 1 ORDER BY n DESC LIMIT 8`, [cid, TZ()]);
  const tpl = await q(`SELECT status, COUNT(*)::int AS n FROM templates WHERE company_id=$1 GROUP BY 1`);
  const [ct] = await q(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE opted_out)::int AS opted_out FROM contacts WHERE company_id=$1 AND NOT is_personal`);
  const [cv] = await q(`SELECT COUNT(*) FILTER (WHERE status='open' AND unread_count>0 AND last_customer_message_at < now() - interval '1 hour'
          AND (last_agent_reply_at IS NULL OR last_agent_reply_at < last_customer_message_at))::int AS waiting,
        COUNT(*) FILTER (WHERE status='open' AND unread_count>0 AND window_expires_at BETWEEN now() AND now() + interval '3 hours'
          AND (last_agent_reply_at IS NULL OR last_agent_reply_at < last_customer_message_at))::int AS closing,
        COUNT(*) FILTER (WHERE assigned_to IS NULL AND bot_step='done' AND status <> 'closed')::int AS unassigned
      FROM conversations WHERE company_id=$1`);
  const [ag] = await q(`SELECT COUNT(*) FILTER (WHERE is_active)::int AS active, COUNT(*) FILTER (WHERE is_active AND in_rotation)::int AS rotation, COUNT(*) FILTER (WHERE is_active AND is_online)::int AS online
      FROM users WHERE company_id=$1 AND (role='agent' OR in_rotation)`);
  const [qm] = await q(`SELECT COUNT(*) FILTER (WHERE active)::int AS active FROM auto_replies WHERE company_id=$1`);
  const away = await settings.get('away');

  // WhatsApp numbers
  if (!nums.length) add('bad', 'WhatsApp number', 'No WhatsApp number is connected', 'Clients cannot reach you and nothing can be sent.', 'Open Settings, WhatsApp numbers, and connect a number.');
  for (const n of nums) {
    const nm = `${n.label}${n.display_phone ? ' (' + n.display_phone + ')' : ''}`;
    if (n.test_mode) { add('info', 'WhatsApp number', `${nm}: test mode`, 'The server runs in test mode, so Meta is not asked about this number.'); continue; }
    if (!n.reachable) { add('bad', 'WhatsApp number', `${nm}: Meta refused the connection`, n.error || 'The access token may have expired.', 'Open Settings, WhatsApp numbers, and reconnect this number with a fresh permanent token.'); continue; }
    if (n.quality === 'RED') add('bad', 'WhatsApp number', `${nm}: quality is Low`, 'Clients are blocking or reporting your messages. Meta can lower your sending limit or restrict the number.', 'Pause broadcasts, send only to people who asked for messages, and make templates clearer.');
    else if (n.quality === 'YELLOW') add('warn', 'WhatsApp number', `${nm}: quality is Medium`, 'Some clients blocked or reported your messages recently.', 'Send fewer promotional messages for a few days and check who you broadcast to.');
    else if (n.quality === 'GREEN') add('ok', 'WhatsApp number', `${nm}: quality is High`, 'Clients are happy to receive your messages.');
    else add('info', 'WhatsApp number', `${nm}: quality not rated yet`, 'Meta shows a rating after the number has sent enough messages.');
    if (n.name_status && !['APPROVED', 'AVAILABLE_WITHOUT_REVIEW', 'NONE'].includes(n.name_status)) add('warn', 'WhatsApp number', `${nm}: display name is ${String(n.name_status).toLowerCase().replace(/_/g, ' ')}`, 'Clients may not see your business name until Meta approves it.', 'Check the display name in WhatsApp Manager.');
    if (n.connection && n.connection !== 'CONNECTED') add('bad', 'WhatsApp number', `${nm}: status is ${String(n.connection).toLowerCase()}`, 'Meta is not delivering messages for this number right now.', 'Open WhatsApp Manager and follow the notice shown for this number.');
  }
  // Delivery
  const fp = pct(d7.failed, d7.outbound), dp = pct(d7.delivered, d7.outbound), rp = pct(d7.read, d7.outbound);
  if (!d7.outbound) add('info', 'Delivery', 'No messages sent in the last 7 days', 'Delivery rates appear after your team or the bot sends messages.');
  else if (fp >= 10) add('bad', 'Delivery', `${fp}% of messages failed in the last 7 days`, `${d7.failed} of ${d7.outbound} messages did not reach the client.`, 'Look at the failure reasons below. The usual causes are a closed 24 hour window, a number without WhatsApp, or a payment problem at Meta.');
  else if (fp >= 3) add('warn', 'Delivery', `${fp}% of messages failed in the last 7 days`, `${d7.failed} of ${d7.outbound} messages did not reach the client.`, 'Look at the failure reasons below.');
  else add('ok', 'Delivery', `${dp}% delivered, ${rp}% read in the last 7 days`, `${d7.outbound} messages sent, ${d7.failed} failed.`);
  // Templates
  const tn = (s) => (tpl.find(x => x.status === s) || {}).n || 0, bad = tpl.filter(x => !['APPROVED', 'PENDING', 'local'].includes(x.status)).reduce((a, x) => a + x.n, 0);
  if (!tn('APPROVED')) add('warn', 'Templates', 'No approved template', 'Without one you cannot write to a client after 24 hours of silence, and broadcasts cannot be sent.', 'Open Templates, create one and submit it to Meta.');
  else add('ok', 'Templates', `${tn('APPROVED')} approved template${tn('APPROVED') === 1 ? '' : 's'}`, tn('PENDING') ? `${tn('PENDING')} more in review at Meta.` : 'Ready for follow-ups and broadcasts.');
  if (bad) add('warn', 'Templates', `${bad} template${bad === 1 ? ' is' : 's are'} rejected or paused`, 'They cannot be sent until fixed.', 'Open Templates, read the reason from Meta and submit a corrected one.');
  // Team and chats
  if (!ag.active) add('bad', 'Team', 'No active agent', 'New clients have nobody to be assigned to.', 'Open Agents and add a team member.');
  else if (!ag.rotation) add('warn', 'Team', 'No agent is in rotation', 'New chats will not be assigned automatically.', 'Open Agents and tick "In rotation" for at least one agent.');
  else add('ok', 'Team', `${ag.rotation} agent${ag.rotation === 1 ? '' : 's'} receiving new chats`, `${ag.online} online right now.`);
  if (cv.unassigned) add('warn', 'Chats', `${cv.unassigned} chat${cv.unassigned === 1 ? ' is' : 's are'} waiting for an agent`, 'These clients finished with the bot but nobody owns the chat.', 'Open Live Chat, Unassigned, and assign them.');
  if (cv.closing) add('bad', 'Chats', `${cv.closing} unanswered chat${cv.closing === 1 ? '' : 's'} will close within 3 hours`, 'After the 24 hour window closes you can only reach these clients with a template.', 'Open Live Chat, Unread, and reply now.');
  if (cv.waiting) add('warn', 'Chats', `${cv.waiting} client${cv.waiting === 1 ? ' has' : 's have'} waited over 1 hour for a reply`, 'Slow replies lose clients and hurt the quality rating.', 'Open Live Chat, Unread.');
  if (!cv.unassigned && !cv.closing && !cv.waiting) add('ok', 'Chats', 'No client is waiting long for a reply', 'All open chats are answered or recent.');
  // Opt-outs and automation
  const op = pct(ct.opted_out, ct.total);
  if (op != null && op >= 5 && ct.opted_out >= 5) add('warn', 'Contacts', `${op}% of contacts unsubscribed`, `${ct.opted_out} of ${ct.total} contacts sent STOP.`, 'Broadcast less often and only to people who asked for it.');
  else add('ok', 'Contacts', `${ct.opted_out} of ${ct.total} contacts unsubscribed`, 'Unsubscribed contacts are skipped in broadcasts automatically.');
  add(away.enabled ? 'ok' : 'info', 'Automation', away.enabled ? 'Away message is on' : 'Away message is off', away.enabled ? `Clients who write outside ${away.start} to ${away.end} get a polite reply.` : 'Clients who write at night get no reply until an agent is back.', away.enabled ? null : 'Open Bot & Away to switch it on.');
  add(qm.active ? 'ok' : 'info', 'Automation', `${qm.active} quick message${qm.active === 1 ? '' : 's'} switched on`, qm.active ? 'Ad and keyword messages are answered automatically.' : 'Ad messages and common questions are not answered automatically.', qm.active ? null : 'Open Quick Message to add one.');
  if (req.user.is_super && !DRY()) add(process.env.WA_APP_SECRET ? 'ok' : 'warn', 'Security', process.env.WA_APP_SECRET ? 'Incoming messages are verified' : 'Incoming messages are not verified',
    process.env.WA_APP_SECRET ? 'The server checks that every webhook really comes from Meta.' : 'Anyone who knows the webhook address could send fake messages.', process.env.WA_APP_SECRET ? null : 'Set the env variable WA_APP_SECRET on Render to the App Secret of your Meta app.');

  const nb = checks.filter(c => c.level === 'bad').length, nw = checks.filter(c => c.level === 'warn').length;
  const order = { bad: 0, warn: 1, info: 2, ok: 3 };
  checks.sort((a, b) => order[a.level] - order[b.level]);
  res.json({ score: Math.max(0, 100 - nb * 25 - nw * 10), bad: nb, warn: nw, ok: checks.filter(c => c.level === 'ok').length, checks, numbers: nums,
    delivery: { ...d7, delivered_pct: dp, read_pct: rp, failed_pct: fp }, errors, checked_at: new Date().toISOString() });
}));

module.exports = router;
