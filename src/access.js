// Permissions (what managers and agents may do in each company) and the Activity Log (who did what).
// Both work as one step in front of every /api route, so no route can be forgotten.
const jwt = require('jsonwebtoken');
const { query } = require('./db');
const auth = require('./auth');

/* ---------- Permissions ---------- */
// Each permission: who it is for, its name on the Permissions page, its default, and the requests it covers.
const PERMS = {
  manager: {
    templates: { label: 'Templates', hint: 'Create, sync and delete message templates', on: true, rules: [['POST|DELETE', /^\/templates(\/|$)/]] },
    broadcasts: { label: 'Bulk Broadcasting', hint: 'Send a template to many contacts at once', on: true, rules: [['ANY', /^\/broadcasts(\/|$)/]] },
    contacts: { label: 'Contacts', hint: 'See the contact list, Audience and Pipeline, edit and import contacts', on: true, rules: [['ANY', /^\/contacts(?!\/lists)(\/|$)/]] },
    automation: { label: 'Quick Message, Quick Replies and Follow-ups', hint: 'Create and change automatic messages, chatbots and the AI Agent', on: true, rules: [['ANY', /^\/(auto-replies|drips|flows|ai|ad-rules|demo-settings)(\/|$)/], ['POST|DELETE', /^\/quick-replies(\/|$)/]] },
    library: { label: 'Media Library', hint: 'Upload, rename and delete saved files', on: true, rules: [['POST|PATCH|DELETE', /^\/media-library(\/|$)/]] },
    catalog: { label: 'Catalogs', hint: 'Add, change and delete products', on: true, rules: [['POST|PATCH|DELETE', /^\/products(\/|$)/]] },
    social: { label: 'Facebook and Instagram Automation', hint: 'Create and change automatic replies to comments and messages', on: true, rules: [['ANY', /^\/social(\/|$)/]] },
    tags: { label: 'Tags', hint: 'Create and delete tags', on: true, rules: [['POST|DELETE', /^\/labels(\/|$)/]] },
    settings: { label: 'Settings, Bot and Away', hint: 'Change the welcome bot, away message, assignment rules and the daily summary', on: true, rules: [['PUT', /^\/settings\//], ['ANY', /^\/summary-settings(\/|$)/]] },
    payments: { label: 'Payments', hint: 'Check payment screenshots and send receipts', on: true, rules: [['ANY', /^\/(payments|payments-settings)(\/|$)/]] },
    reports: { label: 'Reports and Health Audit', hint: 'Open reports and export them', on: true, rules: [['ANY', /^\/(reports|health-audit)(\/|$)/]] },
    reassign: { label: 'Reassign chats', hint: 'Move a chat to another agent or release it', on: true, rules: [['POST', /^\/conversations\/\d+\/(reassign|release)$/]] },
    activity: { label: 'Activity Log', hint: 'See who did what', on: false, rules: [['ANY', /^\/activity-log(\/|$)/]] }
  },
  agent: {
    close: { label: 'Close and reopen chats', hint: 'Mark a chat as closed or open it again', on: true, rules: [['POST', /^\/conversations\/\d+\/status$/]] },
    template: { label: 'Send templates', hint: 'Send an approved template after the 24 hour window', on: true, rules: [['POST', /^\/conversations\/\d+\/template$/]] },
    // Voice notes stay allowed: they are recorded in the chat, not picked from files.
    media: { label: 'Send photos, files and products', hint: 'Send files from the device or the Media Library, and products from the catalog. Voice notes stay allowed.', on: true, rules: [['POST', /^\/conversations\/\d+\/(media|library\/\d+|products)$/, (r) => r.query.filename === 'voice-note' && /^audio\//.test(String(r.query.mime || ''))]] },
    labels: { label: 'Tag chats', hint: 'Add and remove tags on a chat', on: true, rules: [['POST', /^\/conversations\/\d+\/labels$/]] },
    not_client: { label: 'Mark as not a client', hint: 'Remove a personal chat from the client list', on: true, rules: [['POST', /^\/conversations\/\d+\/not-client$/]] },
    calls: { label: 'WhatsApp calls', hint: 'Start a call and ask for call permission', on: true, rules: [['POST', /^\/conversations\/\d+\/(call|call-permission)$/]] }
  }
};
const defaults = (role) => Object.fromEntries(Object.entries(PERMS[role] || {}).map(([k, p]) => [k, p.on]));
const pcache = new Map(); // company id -> { at, value }
async function stored(cid) {
  const c = pcache.get(cid); if (c && Date.now() - c.at < 10000) return c.value;
  const r = (await query(`SELECT value FROM settings WHERE company_id=$1 AND key='permissions'`, [cid])).rows[0];
  const value = (r && r.value) || {}; pcache.set(cid, { at: Date.now(), value }); return value;
}
// What a person with this role may do. Admins may do everything.
async function effective(cid, role) {
  if (!PERMS[role]) return { all: true };
  return { ...defaults(role), ...Object.fromEntries(Object.entries((await stored(cid))[role] || {}).filter(([k]) => k in PERMS[role]).map(([k, v]) => [k, !!v])) };
}
async function matrix(cid) {
  const out = {};
  for (const role of Object.keys(PERMS)) { const eff = await effective(cid, role); out[role] = Object.entries(PERMS[role]).map(([key, p]) => ({ key, label: p.label, hint: p.hint, on: eff[key] })); }
  return out;
}
async function save(cid, body) {
  const value = {};
  for (const role of Object.keys(PERMS)) { value[role] = {}; for (const k of Object.keys(PERMS[role])) value[role][k] = body && body[role] && k in body[role] ? !!body[role][k] : (await effective(cid, role))[k]; }
  await query(`INSERT INTO settings(company_id,key,value) VALUES($1,'permissions',$2) ON CONFLICT (company_id,key) DO UPDATE SET value=EXCLUDED.value`, [cid, value]);
  pcache.delete(cid); return value;
}

/* ---------- Activity Log ---------- */
const look = (fn) => Object.assign(fn, { lookup: true }); // finds the name in the database before the route runs
const byId = (table, col = 'name') => look(async (id, cid) => ((await query(`SELECT ${col} AS n FROM ${table} WHERE id=$1 AND company_id=$2`, [id, cid])).rows[0] || {}).n);
const chat = look(async (id, cid) => ((await query(`SELECT COALESCE(NULLIF(ct.profile_name,''), NULLIF(ct.name,''), '+' || ct.wa_id) AS n FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=$1 AND c.company_id=$2`, [id, cid])).rows[0] || {}).n);
const SETTING = { bot: 'welcome bot', away: 'away message', assign: 'assignment rules', routing: 'department routing', gate: 'keyword filter', wa: 'WhatsApp account' };
// [method, path, area, what happened (text or function of the request), how to find the name of the thing]
const EVENTS = [
  ['POST', /^\/auth\/login$/, 'Account', 'Signed in'],
  ['POST', /^\/me\/password$/, 'Account', 'Changed own password'],
  ['PATCH', /^\/company$/, 'Company', 'Renamed the company', (r) => r.body.name],
  ['PUT', /^\/permissions$/, 'Permissions', 'Changed permissions', (r) => Object.keys(PERMS).flatMap(role => Object.entries((r.body || {})[role] || {}).filter(([k]) => PERMS[role][k]).map(([k, v]) => `${role === 'manager' ? 'Managers' : 'Agents'}: ${PERMS[role][k].label} ${v ? 'on' : 'off'}`)).join(', ')],
  ['POST', /^\/users$/, 'Agents', 'Added a team member', (r) => `${r.body.name || ''} (${r.body.role || 'agent'})`],
  ['PATCH', /^\/users\/(\d+)$/, 'Agents', (r) => r.body.is_active === false ? 'Deactivated a team member' : r.body.is_active === true ? 'Activated a team member' : r.body.password ? 'Reset a team member password' : 'Changed a team member', byId('users')],
  ['POST', /^\/departments$/, 'Agents', 'Added a department', (r) => r.body.name],
  ['PATCH', /^\/departments\/(\d+)$/, 'Agents', 'Renamed a department', byId('departments')],
  ['DELETE', /^\/departments\/(\d+)$/, 'Agents', 'Deleted a department', byId('departments')],
  ['POST', /^\/conversations\/(\d+)\/status$/, 'Chats', (r) => r.body.status === 'closed' ? 'Closed a chat' : 'Reopened a chat', chat],
  ['POST', /^\/conversations\/(\d+)\/reassign$/, 'Chats', 'Reassigned a chat', chat],
  ['POST', /^\/conversations\/(\d+)\/release$/, 'Chats', 'Released a chat', chat],
  ['POST', /^\/conversations\/(\d+)\/not-client$/, 'Chats', 'Marked a chat as not a client', chat],
  ['PUT', /^\/settings\/(\w+)$/, 'Settings', 'Changed settings', (r, m) => SETTING[m[1]] || m[1]],
  ['POST', /^\/quick-replies$/, 'Quick Replies', 'Saved a quick reply', (r) => r.body.shortcut],
  ['DELETE', /^\/quick-replies\/(\d+)$/, 'Quick Replies', 'Deleted a quick reply', byId('quick_replies', 'shortcut')],
  ['POST', /^\/labels$/, 'Tags', 'Added a tag', (r) => r.body.name],
  ['DELETE', /^\/labels\/(\d+)$/, 'Tags', 'Deleted a tag', byId('labels')],
  ['POST', /^\/templates$/, 'Templates', 'Created a template', (r) => r.body.name],
  ['POST', /^\/templates\/sync$/, 'Templates', 'Synced templates with Meta'],
  ['DELETE', /^\/templates\/(\d+)$/, 'Templates', 'Deleted a template', byId('templates')],
  ['POST', /^\/contacts\/import$/, 'Contacts', 'Imported contacts', (r) => r.body.list_name || r.body.list || ''],
  ['PATCH', /^\/contacts\/(\d+)$/, 'Contacts', 'Changed a contact', byId('contacts', `COALESCE(NULLIF(name,''), '+' || wa_id)`)],
  ['POST', /^\/contacts$/, 'Contacts', 'Added a contact', (r) => r.body.name || r.body.phone],
  ['DELETE', /^\/contacts\/(\d+)$/, 'Contacts', 'Deleted a contact', byId('contacts', `COALESCE(NULLIF(name,''), NULLIF(profile_name,''), '+' || wa_id)`)],
  ['POST', /^\/contacts\/delete$/, 'Contacts', 'Deleted contacts', (r) => `${(r.body.ids || []).length} contacts`],
  ['POST', /^\/contacts\/ignore$/, 'Contacts', 'Changed the ignore list'],
  ['POST', /^\/contacts\/fields$/, 'Contacts', 'Added a custom field', (r) => r.body.name],
  ['PATCH', /^\/contacts\/fields\/(\d+)$/, 'Contacts', 'Changed a custom field', byId('contact_fields')],
  ['DELETE', /^\/contacts\/fields\/(\d+)$/, 'Contacts', 'Deleted a custom field', byId('contact_fields')],
  ['POST', /^\/contacts\/pipeline\/stages$/, 'Pipeline', 'Added a stage', (r) => r.body.name],
  ['PATCH', /^\/contacts\/pipeline\/stages\/(\d+)$/, 'Pipeline', 'Changed a stage', look(async (id, cid) => ((await query('SELECT l.name AS n FROM pipeline_stages s JOIN labels l ON l.id=s.label_id WHERE s.id=$1 AND s.company_id=$2', [id, cid])).rows[0] || {}).n)],
  ['DELETE', /^\/contacts\/pipeline\/stages\/(\d+)$/, 'Pipeline', 'Removed a stage', look(async (id, cid) => ((await query('SELECT l.name AS n FROM pipeline_stages s JOIN labels l ON l.id=s.label_id WHERE s.id=$1 AND s.company_id=$2', [id, cid])).rows[0] || {}).n)],
  ['POST', /^\/broadcasts$/, 'Broadcasts', 'Started a broadcast', (r) => r.body.name],
  ['POST', /^\/broadcasts\/(\d+)\/cancel$/, 'Broadcasts', 'Cancelled a broadcast', byId('broadcasts')],
  ['POST', /^\/drips$/, 'Follow-ups', 'Created a follow-up', (r) => r.body.name],
  ['PATCH', /^\/drips\/(\d+)$/, 'Follow-ups', (r) => r.body.active === false ? 'Switched off a follow-up' : 'Switched on a follow-up', byId('drips')],
  ['DELETE', /^\/drips\/(\d+)$/, 'Follow-ups', 'Deleted a follow-up', byId('drips')],
  ['POST', /^\/whatsapp\/numbers$/, 'WhatsApp numbers', 'Added a WhatsApp number', (r) => r.body.label || r.body.display_phone || ''],
  ['POST', /^\/whatsapp\/embedded-signup$/, 'WhatsApp numbers', 'Connected a WhatsApp number'],
  ['PATCH', /^\/whatsapp\/numbers\/(\d+)$/, 'WhatsApp numbers', 'Changed a WhatsApp number', byId('wa_numbers', 'label')],
  ['DELETE', /^\/whatsapp\/numbers\/(\d+)$/, 'WhatsApp numbers', 'Removed a WhatsApp number', byId('wa_numbers', 'label')],
  ['POST', /^\/media-library$/, 'Media Library', 'Uploaded a file', (r) => r.query.filename],
  ['PATCH', /^\/media-library\/(\d+)$/, 'Media Library', 'Renamed a file', byId('media_library')],
  ['DELETE', /^\/media-library\/(\d+)$/, 'Media Library', 'Deleted a file', byId('media_library')],
  ['POST', /^\/auto-replies$/, 'Quick Message', 'Created a quick message', (r) => r.body.name],
  ['PATCH', /^\/auto-replies\/(\d+)$/, 'Quick Message', (r) => Object.keys(r.body || {}).join() === 'active' ? (r.body.active ? 'Switched on a quick message' : 'Switched off a quick message') : 'Changed a quick message', byId('auto_replies')],
  ['DELETE', /^\/auto-replies\/(\d+)$/, 'Quick Message', 'Deleted a quick message', byId('auto_replies')],
  ['POST', /^\/flows$/, 'Chatbots', 'Created a chatbot', (r) => r.body.name],
  ['PATCH', /^\/flows\/(\d+)$/, 'Chatbots', (r) => Object.keys(r.body || {}).join() === 'active' ? (r.body.active ? 'Switched on a chatbot' : 'Switched off a chatbot') : 'Changed a chatbot', byId('bot_flows')],
  ['DELETE', /^\/flows\/(\d+)$/, 'Chatbots', 'Deleted a chatbot', byId('bot_flows')],
  ['POST', /^\/ad-rules$/, 'Ad routing', 'Created an ad rule', (r) => r.body.name || String(r.body.keywords || '')],
  ['PATCH', /^\/ad-rules\/(\d+)$/, 'Ad routing', (r) => Object.keys(r.body || {}).join() === 'active' ? (r.body.active ? 'Switched on an ad rule' : 'Switched off an ad rule') : 'Changed an ad rule', byId('ad_rules')],
  ['DELETE', /^\/ad-rules\/(\d+)$/, 'Ad routing', 'Deleted an ad rule', byId('ad_rules')],
  ['POST', /^\/payments\/(\d+)\/confirm$/, 'Payments', 'Confirmed a payment', (r) => `${r.body.currency || 'PKR'} ${r.body.amount || ''} ${r.body.item || ''}`.trim()],
  ['POST', /^\/payments\/(\d+)\/reject$/, 'Payments', (r) => r.body.notify ? 'Marked a payment not received' : 'Marked a photo as not a payment'],
  ['POST', /^\/messages\/(\d+)\/payment$/, 'Payments', 'Marked a photo as a payment'],
  ['PUT', /^\/payments-settings$/, 'Payments', 'Changed the payment settings'],
  ['PUT', /^\/summary-settings$/, 'Daily summary', 'Changed the daily summary', (r) => r.body.enabled === false ? 'switched off' : ''],
  ['POST', /^\/summary-settings\/send$/, 'Daily summary', 'Sent the daily summary now'],
  ['POST', /^\/summary-settings\/template$/, 'Daily summary', 'Sent the daily summary template to Meta'],
  ['PUT', /^\/demo-settings$/, 'Demo classes', 'Changed the demo class settings', (r) => r.body.enabled === false ? 'switched off' : ''],
  ['PUT', /^\/demo-settings\/link$/, 'Demo classes', 'Set a class link', (r) => `${r.body.place || ''} ${r.body.day || ''}`],
  ['POST', /^\/demo\/bookings$/, 'Demo classes', 'Booked a demo seat', (r) => `${r.body.place || ''} ${r.body.day || ''}`],
  ['PATCH', /^\/demo\/bookings\/(\d+)$/, 'Demo classes', (r) => ({ came: 'Marked came', missed: "Marked didn't come", joined: 'Marked joined', cancelled: 'Cancelled a seat', booked: 'Marked booked' })[r.body.status] || 'Changed a seat'],
  ['POST', /^\/products$/, 'Catalogs', 'Added a product', (r) => r.body.name],
  ['PATCH', /^\/products\/(\d+)$/, 'Catalogs', (r) => Object.keys(r.body || {}).join() === 'in_stock' ? (r.body.in_stock ? 'Marked a product in stock' : 'Marked a product out of stock') : 'Changed a product', byId('products')],
  ['DELETE', /^\/products\/(\d+)$/, 'Catalogs', 'Deleted a product', byId('products')],
  ['POST', /^\/social\/(facebook|instagram)\/rules$/, 'Social Media', (r) => `Created ${/instagram/.test(r.path) ? 'an Instagram' : 'a Facebook'} rule`, (r) => r.body.name],
  ['PATCH', /^\/social\/rules\/(\d+)$/, 'Social Media', (r) => Object.keys(r.body || {}).join() === 'active' ? (r.body.active ? 'Switched on a social rule' : 'Switched off a social rule') : 'Changed a social rule', byId('social_rules')],
  ['DELETE', /^\/social\/rules\/(\d+)$/, 'Social Media', 'Deleted a social rule', byId('social_rules')],
  ['PATCH', /^\/super\/companies\/(\d+)$/, 'Companies', (r) => 'plan' in (r.body || {}) ? 'Changed the plan of a company' : 'name' in (r.body || {}) ? 'Renamed a company' : r.body.status === 'paused' ? 'Paused a company' : r.body.status === 'rejected' ? 'Rejected a company' : r.body.status === 'active' ? 'Accepted or resumed a company' : 'Changed a company', look(async (id) => ((await query('SELECT name AS n FROM companies WHERE id=$1', [id])).rows[0] || {}).n)],
  ['POST', /^\/super\/companies\/(\d+)\/admin$/, 'Companies', 'Changed the sign-in of a company admin', look(async (id) => ((await query('SELECT name AS n FROM companies WHERE id=$1', [id])).rows[0] || {}).n)],
  ['PATCH', /^\/super\/requests\/(\d+)$/, 'Companies', (r) => r.body.status === 'approved' ? 'Approved a request' : r.body.status === 'declined' ? 'Declined a request' : 'Reopened a request', look(async (id) => ((await query('SELECT co.name AS n FROM company_requests q JOIN companies co ON co.id=q.company_id WHERE q.id=$1', [id])).rows[0] || {}).n)],
  ['POST', /^\/requests$/, 'Company', 'Sent a request to TeamInbox Pro', (r) => String(r.body.message || '').slice(0, 80)],
  ['PUT', /^\/super\/plans\/(\w+)$/, 'Companies', 'Changed the limits of a plan', look(async (key) => ((await query('SELECT name AS n FROM plans WHERE key=$1', [key])).rows[0] || {}).n)]
];
async function log({ cid, userId, userName, role, area, action, detail, ip }) {
  try {
    await query('INSERT INTO activity_log(company_id,user_id,user_name,role,area,action,detail,ip) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [cid, userId || null, String(userName || '').slice(0, 120), role || null, area, action, String(detail || '').slice(0, 300), String(ip || '').slice(0, 60)]);
  } catch (e) { console.error('activity log', e.message); }
}

/* ---------- The step in front of every /api route ---------- */
const covers = (req) => ([m, re, except]) => (m === 'ANY' || m.split('|').includes(req.method)) && re.test(req.path) && !(except && except(req));
async function actor(req) {
  try {
    const tok = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET), cur = await auth.current(tok.id);
    return auth.valid(tok, cur) ? { id: tok.id, name: tok.name, role: cur.role, cid: cur.company_id } : null;
  } catch { return null; }
}
function gate(req, res, next) {
  const ev = req.method === 'GET' ? null : EVENTS.find(e => e[0] === req.method && e[1].test(req.path));
  const guarded = Object.values(PERMS).some(role => Object.values(role).some(p => p.rules.some(covers(req))));
  if (!ev && !guarded) return next();
  (async () => {
    const who = await actor(req);
    if (who && guarded && PERMS[who.role]) {
      const eff = await effective(who.cid, who.role);
      const hit = Object.entries(PERMS[who.role]).find(([k, p]) => !eff[k] && p.rules.some(covers(req)));
      if (hit) return res.status(403).json({ error: `Your admin has switched off "${hit[1].label}" for ${who.role}s.`, permission: hit[0] });
    }
    if (ev) {
      const m = req.path.match(ev[1]);
      // The name is read before the route runs, because afterwards the thing may be gone.
      let name = ''; if (who && ev[4] && ev[4].lookup && m[1]) try { name = await ev[4](Number(m[1]), who.cid); } catch {}
      const json = res.json.bind(res); let sent;
      res.json = (body) => { sent = body; return json(body); };
      res.on('finish', () => {
        if (res.statusCode >= 300) return;
        let w = who; if (!w && sent && sent.user && sent.user.company_id) w = { id: sent.user.id, name: sent.user.name, role: sent.user.role, cid: sent.user.company_id };
        if (!w) return;
        let detail = name; if (!detail && ev[4] && !ev[4].lookup) try { detail = ev[4](req, m) || ''; } catch { detail = ''; }
        log({ cid: w.cid, userId: w.id, userName: w.name, role: w.role, area: ev[2], action: typeof ev[3] === 'function' ? ev[3](req) : ev[3], detail, ip: req.ip });
      });
    }
    next();
  })().catch(next);
}
module.exports = { gate, effective, matrix, save, log, PERMS };
