const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { sign, required } = require('../auth');
const wa = require('../whatsapp');
const { saveOutbound, windowInfo } = require('../messages');
const { assignConversation } = require('../assign');
const rt = require('../realtime');
const mediaStore = require('../media');
const push = require('../push');
const plan = require('../plan');
const router = express.Router();
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });
const isAgent = (u) => u.role === 'agent';
const settings = require('../settings');
const { markPersonal } = require('../personal');
const bot = require('../bot');
const { toMp3 } = require('../audio');
const tenant = require('../tenant');
const C = () => tenant.cid(); // the signed-in person's company; every query below is limited to it
async function replyCtx(convId, id) {
  if (!id) return null;
  const r = (await query('SELECT wa_message_id FROM messages WHERE id=$1 AND conversation_id=$2', [Number(id), convId])).rows[0];
  return (r && r.wa_message_id) || null;
}
const NUMBER_LABEL_SQL = `(CASE WHEN (SELECT COUNT(*) FROM wa_numbers WHERE company_id=c.company_id) > 1 THEN (SELECT n.label FROM wa_numbers n WHERE n.id=c.wa_number_id) END) AS number_label`;
const LABELS_SQL = `(SELECT COALESCE(json_agg(json_build_object('id',l.id,'name',l.name,'color',l.color)),'[]'::json) FROM conversation_labels cl JOIN labels l ON l.id=cl.label_id WHERE cl.conversation_id=c.id) AS labels`;

const attempts = new Map(); // "ip|email" -> { n, since }
// One sign-in for every copy. CLIENT_SITES lists the separate copies that clients run on (comma separated, for example
// https://wof.teaminboxpro.com). When an email is not known here, the same email and password are tried on each copy,
// and on a match the person is sent to their own copy, already signed in. Data stays where it is, nothing is copied.
// CLIENT_SITES is typed by hand on Render, so it is read forgivingly: quotes, spaces, a missing https:// or a trailing path do not break it.
const clientSites = () => [...new Set(String(process.env.CLIENT_SITES || '').split(/[\s,;]+/).map(s => s.replace(/["'`]/g, '').replace(/^client_sites=/i, '').trim()).filter(Boolean).map(s => {
  const local = s.match(/^(?:http:\/\/)?(localhost(?::\d+)?)(?:\/.*)?$/i); if (local) return 'http://' + local[1].toLowerCase();
  const m = s.match(/^(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/.*)?$/i); return m ? 'https://' + m[1].toLowerCase() : null; }).filter(Boolean))];
async function signInElsewhere(email, password) {
  for (const site of clientSites()) {
    try {
      const r = await fetch(site + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sign-In-From': 'main' }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(8000) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.token) return { go: site + '/#signin=' + Buffer.from(JSON.stringify({ token: d.token, user: d.user })).toString('base64url') };
      console.log('sign-in check on', site, 'answered', r.status);
      if (r.status === 403 && d.error) return { status: 403, error: d.error }; // right password, but that company is waiting or paused
    } catch (e) { console.error('sign-in check on', site, e.message); }
  }
  return null;
}
router.post('/auth/login', wrap(async (req, res) => {
  const password = req.body.password, email = String(req.body.email || '').trim().toLowerCase();
  const key = `${req.ip}|${email}`, rec = attempts.get(key);
  if (rec && Date.now() - rec.since > 15 * 60000) attempts.delete(key);
  if ((attempts.get(key)?.n || 0) >= 8) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  const u = (await query('SELECT u.*, co.status AS company_status, co.name AS company_name FROM users u JOIN companies co ON co.id=u.company_id WHERE u.email=$1 AND u.is_active', [email])).rows[0];
  if (!u || !(await bcrypt.compare(password || '', u.password_hash))) {
    // not right here: maybe the account lives on a client's own copy, also when the same email exists here with another password
    // (a request that already came from another copy is never passed on)
    if (email && password && !req.headers['x-sign-in-from']) {
      const other = await signInElsewhere(email, String(password));
      if (other && other.go) { attempts.delete(key); return res.json({ go: other.go }); }
      if (other && !u) return res.status(other.status).json({ error: other.error });
    }
    const r = attempts.get(key) || { n: 0, since: Date.now() }; r.n++; attempts.set(key, r);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  attempts.delete(key);
  if (u.company_status !== 'active' && !tenant.isSuper(u.email)) return res.status(403).json({ error: u.company_status === 'pending' ? 'Your account is waiting for approval. We will email you when it is ready.'
    : u.company_status === 'rejected' ? 'Your sign-up was not accepted. Contact us if you think this is a mistake.' : 'This company account is paused. Contact support.' });
  res.json({ token: sign(u), user: { id: u.id, name: u.name, role: u.role, team: u.team, company: u.company_name, company_id: u.company_id, is_super: tenant.isSuper(u.email), perms: await require('../access').effective(u.company_id, u.role) } });
}));

// ---- Forgot / reset password (link sent by email, valid for 1 hour, single use) ----
const crypto = require('crypto');
const mail = require('../mail');
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const resetHits = new Map();
const allow = (key, max, windowMs) => {
  const now = Date.now(), a = (resetHits.get(key) || []).filter(t => now - t < windowMs);
  if (a.length >= max) { resetHits.set(key, a); return false; }
  a.push(now); resetHits.set(key, a); return true;
};
router.post('/auth/forgot', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  // Same answer whether or not the email exists, sent before any work, so nobody can probe which emails have accounts.
  res.json({ ok: true, message: 'If that email belongs to an account, a reset link is on its way. It works for 1 hour.' });
  if (!email || !allow('ip|' + req.ip, 20, 3600e3) || !allow('em|' + email, 3, 3600e3)) return;
  try {
    const u = (await query('SELECT id, name, email FROM users WHERE email=$1 AND is_active', [email])).rows[0];
    if (!u) return;
    const base = String(process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
    if (!base) throw new Error('APP_URL is not set, so the reset link cannot be built');
    const raw = crypto.randomBytes(32).toString('hex');
    await query('UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [u.id]);
    await query(`INSERT INTO password_resets(user_id, token_hash, expires_at) VALUES($1,$2, now() + interval '1 hour')`, [u.id, sha(raw)]);
    const link = `${base}/?reset=${raw}`;
    await mail.send({
      to: u.email, subject: 'Reset your Team Inbox password',
      text: `Hi ${u.name},\n\nUse this link to choose a new password. It works once and expires in 1 hour:\n${link}\n\nIf you did not ask for this, ignore this email. Your password stays the same.`,
      html: `<p>Hi ${String(u.name).replace(/[<>&]/g, '')},</p><p>Use the button below to choose a new password. The link works once and expires in 1 hour.</p><p><a href="${link}" style="background:#00a884;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Choose a new password</a></p><p style="color:#667781;font-size:13px">If the button does not work, paste this into your browser:<br>${link}</p><p style="color:#667781;font-size:13px">If you did not ask for this, ignore this email. Your password stays the same.</p>`
    });
  } catch (e) { console.error('password reset email:', e.message); }
}));
router.post('/auth/reset', wrap(async (req, res) => {
  if (!allow('rs|' + req.ip, 30, 3600e3)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const { token, password } = req.body;
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'The new password must be at least 8 characters' });
  const r = (await query(
    `SELECT pr.user_id FROM password_resets pr JOIN users u ON u.id=pr.user_id AND u.is_active
      WHERE pr.token_hash=$1 AND pr.used_at IS NULL AND pr.expires_at > now()`, [sha(token || '')])).rows[0];
  if (!r) return res.status(400).json({ error: 'This link is invalid or has expired. Ask for a new one.' });
  await query('UPDATE users SET password_hash=$2, session_version = session_version + 1 WHERE id=$1', [r.user_id, await bcrypt.hash(String(password), 10)]); require('../auth').forget(r.user_id);
  await query('UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [r.user_id]);
  res.json({ ok: true });
}));

// ---- Sign-up: a new company creates its own account (only when SIGNUP_ENABLED=true on the server) ----
const signupOn = () => process.env.SIGNUP_ENABLED === 'true';
// Emails are a courtesy: a mail problem never stops the action itself.
const send = (to, subject, text) => mail.send({ to, subject, text, html: `<p>${String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>` }).catch(e => console.error('[mail]', e.message));
const toSupers = (subject, text) => (process.env.SUPER_ADMIN_EMAILS || '').split(',').map(x => x.trim()).filter(Boolean).forEach(to => send(to, subject, text));
router.get('/auth/config', (req, res) => res.json({ signup: signupOn() }));
router.post('/auth/signup', wrap(async (req, res) => {
  if (!signupOn()) return res.status(403).json({ error: 'Sign-up is not open yet. Contact us to get an account.' });
  if (!allow('su|' + req.ip, 5, 3600e3)) return res.status(429).json({ error: 'Too many sign-ups from this connection. Try again later.' });
  const company = String(req.body.company || '').trim().slice(0, 80), name = String(req.body.name || '').trim().slice(0, 60);
  const email = String(req.body.email || '').trim().toLowerCase(), password = String(req.body.password || '');
  if (!company) return res.status(400).json({ error: 'Enter your company name' });
  if (!name) return res.status(400).json({ error: 'Enter your name' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (password.length < 8) return res.status(400).json({ error: 'The password must be at least 8 characters' });
  if ((await query('SELECT 1 FROM users WHERE email=$1', [email])).rows[0]) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
  let made;
  try { made = await require('../companies').create({ company, name, email, password, status: 'pending' }); }
  catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' }); throw e; }
  console.log(`[signup] new company #${made.company.id} "${company}" is waiting for approval`);
  toSupers('A new company is waiting for approval', `${company} (${name}, ${email}) signed up for TeamInbox Pro. Open Super Admin, Overview to accept or reject it.`);
  // A new company cannot sign in until TeamInbox Pro accepts it on the Super Admin page.
  res.json({ pending: true, company_id: made.company.id });
}));

// ---- Super admin (emails listed in SUPER_ADMIN_EMAILS): see every company, pause or resume one ----
router.get('/super/companies', required('super'), wrap(async (req, res) => res.json(await require('../companies').list())));
// Plans: the limits of Free, Starter and Pro, changed by the super admin
router.get('/super/plans', required('super'), wrap(async (req, res) => res.json(await plan.plans())));
router.put('/super/plans/:key', required('super'), wrap(async (req, res) => {
  const l = plan.cleanLimits(req.body), name = String(req.body.name || '').trim().slice(0, 30);
  const r = (await query(`UPDATE plans SET members=$2, numbers=$3, broadcast=$4, storage_mb=$5, name=COALESCE(NULLIF($6,''), name), ai_replies=$7 WHERE key=$1 RETURNING key`, [req.params.key, l.members, l.numbers, l.broadcast, l.storage_mb, name, l.ai_replies])).rows[0];
  r ? res.json({ ok: true }) : res.status(404).json({ error: 'Plan not found' });
}));
// The signed-in company's own plan and how much of it is used
router.get('/plan', required('admin', 'manager'), wrap(async (req, res) => res.json({ ...(await plan.current()), usage: await plan.usage() })));
router.patch('/super/companies/:id', required('super'), wrap(async (req, res) => {
  const id = Number(req.params.id), status = req.body.status;
  if ('plan' in req.body) { // plan, trial end date, note and (for Custom) its own limits
    const b = req.body, p = String(b.plan);
    if (!plan.PLAN_KEYS.includes(p)) return res.status(400).json({ error: 'Unknown plan' });
    const te = (p === 'starter' || p === 'pro') && b.trial_ends ? String(b.trial_ends) : null;
    if (te && (!/^\d{4}-\d{2}-\d{2}$/.test(te) || isNaN(Date.parse(te)))) return res.status(400).json({ error: 'Choose a valid trial end date' });
    const r = (await query('UPDATE companies SET plan=$2, trial_ends=$3, plan_note=$4, limits=$5 WHERE id=$1 RETURNING id',
      [id, p, te, String(b.plan_note || '').trim().slice(0, 300), JSON.stringify(p === 'custom' ? plan.cleanLimits(b.limits) : {})])).rows[0];
    return r ? res.json({ ok: true }) : res.status(404).json({ error: 'Company not found' });
  }
  if ('name' in req.body) {
    const name = String(req.body.name || '').trim().slice(0, 80); if (!name) return res.status(400).json({ error: 'Enter the company name' });
    const r = (await query('UPDATE companies SET name=$2 WHERE id=$1 RETURNING id', [id, name])).rows[0];
    return r ? res.json({ ok: true }) : res.status(404).json({ error: 'Company not found' });
  }
  if (!['active', 'paused', 'rejected'].includes(status)) return res.status(400).json({ error: 'Unknown status' });
  if (id === req.user.cid && status !== 'active') return res.status(409).json({ error: 'You cannot pause your own company' });
  const before = (await query('SELECT status, name FROM companies WHERE id=$1', [id])).rows[0];
  if (!before) return res.status(404).json({ error: 'Company not found' });
  if (status === 'rejected' && before.status !== 'pending') return res.status(409).json({ error: 'Only a company that is waiting for approval can be rejected. Pause it instead.' });
  const reason = status === 'active' ? '' : String(req.body.reason || '').trim().slice(0, 300);
  await query('UPDATE companies SET status=$2, status_reason=$3, decided_at=now() WHERE id=$1', [id, status, reason]);
  require('../auth').forgetAll(); // signed-in people of a paused company are stopped within seconds
  if (before.status === 'pending' && status !== 'paused') { // tell the person who signed up
    const adm = (await query(`SELECT email, name FROM users WHERE company_id=$1 AND role='admin' ORDER BY id LIMIT 1`, [id])).rows[0];
    if (adm) send(adm.email, status === 'active' ? 'Your TeamInbox Pro account is ready' : 'About your TeamInbox Pro sign-up',
      status === 'active' ? `Hello ${adm.name}, your account for ${before.name} is ready. You can sign in now with the email and password you chose.`
        : `Hello ${adm.name}, we could not accept the sign-up for ${before.name}.${reason ? ' Reason: ' + reason : ''} Reply to this email if you think this is a mistake.`);
  }
  res.json({ ok: true });
}));
// Everything about one company on one screen: its team, numbers, plan, usage and latest requests
router.get('/super/companies/:id', required('super'), wrap(async (req, res) => {
  const id = Number(req.params.id) || 0, co = (await require('../companies').list()).find(c => c.id === id);
  if (!co) return res.status(404).json({ error: 'Company not found' });
  const [team, nums, reqs] = await Promise.all([
    query(`SELECT id, name, email, role, is_active, created_at FROM users WHERE company_id=$1 ORDER BY (role='admin') DESC, id`, [id]),
    query('SELECT label, display_phone, is_default FROM wa_numbers WHERE company_id=$1 ORDER BY id', [id]),
    query('SELECT id, kind, message, status, reply, user_name, created_at FROM company_requests WHERE company_id=$1 ORDER BY id DESC LIMIT 5', [id])]);
  res.json({ ...co, team: team.rows, wa_numbers: nums.rows, requests: reqs.rows, current: await plan.current(id), usage: await plan.usage(id) });
}));
// Change the sign-in of a company's first admin: a new email, a new password, or both
router.post('/super/companies/:id/admin', required('super'), wrap(async (req, res) => {
  const id = Number(req.params.id) || 0, adm = (await query(`SELECT id FROM users WHERE company_id=$1 AND role='admin' ORDER BY id LIMIT 1`, [id])).rows[0];
  if (!adm) return res.status(404).json({ error: 'This company has no admin' });
  const email = String(req.body.email || '').trim().toLowerCase(), password = String(req.body.password || '');
  if (!email && !password) return res.status(400).json({ error: 'Type a new email or a new password' });
  if (email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if ((await query('SELECT 1 FROM users WHERE email=$1 AND id<>$2', [email, adm.id])).rows[0]) return res.status(409).json({ error: 'That email is already used by someone else' });
    await query('UPDATE users SET email=$2 WHERE id=$1', [adm.id, email]);
  }
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: 'The password must be at least 8 characters' });
    await query('UPDATE users SET password_hash=$2 WHERE id=$1', [adm.id, await bcrypt.hash(password, 10)]);
  }
  await query('UPDATE users SET session_version = session_version + 1 WHERE id=$1', [adm.id]); require('../auth').forget(adm.id);
  res.json({ ok: true });
}));

// ---- Requests: a company admin asks TeamInbox Pro for a change, the super admin approves or declines ----
const REQ_KINDS = ['members', 'numbers', 'plan', 'other'];
router.get('/requests', required('admin'), wrap(async (req, res) => res.json((await query(
  'SELECT id, kind, message, status, reply, user_name, created_at, decided_at FROM company_requests WHERE company_id=$1 ORDER BY id DESC LIMIT 20', [C()])).rows)));
router.post('/requests', required('admin'), wrap(async (req, res) => {
  const kind = REQ_KINDS.includes(req.body.kind) ? req.body.kind : 'other', message = String(req.body.message || '').trim().slice(0, 1000);
  if (!message) return res.status(400).json({ error: 'Tell us what you need' });
  if ((await query(`SELECT COUNT(*)::int AS n FROM company_requests WHERE company_id=$1 AND status='open'`, [C()])).rows[0].n >= 5)
    return res.status(400).json({ error: 'You already have 5 open requests. Please wait for an answer.' });
  const r = (await query('INSERT INTO company_requests(company_id, user_id, user_name, kind, message) VALUES($1,$2,$3,$4,$5) RETURNING id, kind, message, status, created_at', [C(), req.user.id, req.user.name || '', kind, message])).rows[0];
  const co = (await query('SELECT name FROM companies WHERE id=$1', [C()])).rows[0];
  toSupers('A company sent a request', `${co ? co.name : 'A company'} asks: ${message}. Open Super Admin, Requests to answer.`);
  res.json(r);
}));
router.get('/super/requests', required('super'), wrap(async (req, res) => res.json((await query(
  `SELECT q.id, q.company_id, co.name AS company, q.user_name, q.kind, q.message, q.status, q.reply, q.created_at, q.decided_at
     FROM company_requests q JOIN companies co ON co.id=q.company_id ORDER BY (q.status='open') DESC, q.id DESC LIMIT 200`)).rows)));
router.patch('/super/requests/:id', required('super'), wrap(async (req, res) => {
  const status = req.body.status; if (!['approved', 'declined', 'open'].includes(status)) return res.status(400).json({ error: 'Unknown status' });
  const r = (await query(`UPDATE company_requests SET status=$2, reply=$3, decided_at=CASE WHEN $2='open' THEN NULL ELSE now() END WHERE id=$1 RETURNING id`,
    [Number(req.params.id) || 0, status, String(req.body.reply || '').trim().slice(0, 500)])).rows[0];
  r ? res.json({ ok: true }) : res.status(404).json({ error: 'Request not found' });
}));
// Company name, changed by its admin
router.patch('/company', required('admin'), wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80); if (!name) return res.status(400).json({ error: 'Enter the company name' });
  await query('UPDATE companies SET name=$2 WHERE id=$1', [C(), name]); res.json({ ok: true });
}));

router.post('/me/password', required(), wrap(async (req, res) => {
  const { current, password } = req.body;
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'The new password must be at least 8 characters' });
  const u = (await query('SELECT * FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (!(await bcrypt.compare(current || '', u.password_hash))) return res.status(403).json({ error: 'Your current password is not correct' });
  await query('UPDATE users SET password_hash=$2 WHERE id=$1', [u.id, await bcrypt.hash(password, 10)]); res.json({ ok: true });
}));
router.get('/me', required(), wrap(async (req, res) => {
  const u = (await query('SELECT u.id,u.name,u.email,u.role,u.team,u.company_id,co.name AS company FROM users u JOIN companies co ON co.id=u.company_id WHERE u.id=$1', [req.user.id])).rows[0];
  res.json({ ...u, is_super: req.user.is_super, perms: await require('../access').effective(u.company_id, u.role) });
}));

// ---- Conversations: agents only ever see their own ----
async function loadConversation(req, res) {
  const c = (await query(
    `SELECT c.*, ct.wa_id, COALESCE(ct.profile_name, ct.name) AS contact_name, COALESCE((SELECT n.calls_enabled FROM wa_numbers n WHERE n.id = COALESCE(c.wa_number_id, (SELECT id FROM wa_numbers WHERE is_default AND company_id=c.company_id LIMIT 1))), false) AS calls_enabled, ${NUMBER_LABEL_SQL}, ${LABELS_SQL}, ct.profile_name, ct.name AS given_name, ct.source, ct.channel, ct.ad_source_url, ct.ad_headline, ct.list_name, ct.opted_out, ct.created_at AS contact_since, (SELECT name FROM users WHERE id=c.assigned_to) AS agent_name FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=$1 AND c.company_id=$2`,
    [Number(req.params.id) || 0, C()])).rows[0];
  if (!c) { res.status(404).json({ error: 'not found' }); return null; }
  if (isAgent(req.user) && c.assigned_to !== req.user.id) { res.status(403).json({ error: 'not your conversation' }); return null; }
  return c;
}

router.get('/conversations/counts', required(), wrap(async (req, res) => {
  const me = Number(req.user.id), own = (isAgent(req.user) ? `AND c.assigned_to=${me}` : '') + ` AND c.company_id=${Number(C())}`;
  const r = (await query(`SELECT
      COUNT(*) FILTER (WHERE (c.status='open' OR (c.status='bot' AND c.bot_step='done' AND c.assigned_to IS NULL)) AND c.bot_step<>'held' AND NOT COALESCE(f.archived,false) AND (c.unread_count>0 OR COALESCE(f.marked_unread,false)))::int AS unread,
      COUNT(*) FILTER (WHERE c.status<>'bot' AND c.bot_step<>'held' AND NOT COALESCE(f.archived,false) AND COALESCE(f.favorite,false))::int AS fav,
      COUNT(*) FILTER (WHERE c.status<>'bot' AND c.bot_step<>'held' AND COALESCE(f.archived,false))::int AS archived,
      COUNT(*) FILTER (WHERE c.assigned_to IS NULL AND c.bot_step='done')::int AS unassigned,
      COUNT(*) FILTER (WHERE c.bot_step='held')::int AS held,
      COUNT(*) FILTER (WHERE c.status='open' AND c.assigned_to=${me} AND c.bot_step<>'held' AND NOT COALESCE(f.archived,false))::int AS mine
    FROM conversations c LEFT JOIN chat_flags f ON f.conversation_id=c.id AND f.user_id=${me} WHERE TRUE ${own}`)).rows[0];
  if (isAgent(req.user)) { r.unassigned = 0; r.held = 0; }
  res.json(r);
}));

router.get('/conversations', required(), wrap(async (req, res) => {
  const { status, assigned_to, q, unassigned, view } = req.query;
  const me = Number(req.user.id), where = ['c.company_id=$1'], p = [C()];
  if (isAgent(req.user)) { p.push(req.user.id); where.push(`c.assigned_to=$${p.length}`); }
  else if (assigned_to) { p.push(assigned_to); where.push(`c.assigned_to=$${p.length}`); }
  if (unassigned === 'true') where.push(`c.assigned_to IS NULL AND c.bot_step='done'`);
  // "All" also shows clients who finished the bot but got no agent (for example when the company has no agents yet), so nobody is missed.
  // Chats the AI Agent is answering (bot_step 'ai') are listed too, so the team can watch and step in.
  // Managers also see clients who are still talking to the chatbot or the welcome bot, with their number, so nobody from an ad is missed.
  if (status === 'open') where.push(isAgent(req.user) ? "(c.status='open' OR (c.status='bot' AND (c.bot_step='ai' OR (c.bot_step='done' AND c.assigned_to IS NULL))))" : "c.status IN ('open','bot')");
  else if (status) { p.push(status); where.push(`c.status=$${p.length}`); }
  else if (!unassigned) where.push(`(c.status <> 'bot' OR c.bot_step='ai')`);
  where.push(req.query.held === 'true' ? "c.bot_step='held'" : "c.bot_step <> 'held'");
  where.push(view === 'archived' ? 'COALESCE(f.archived,false)' : 'NOT COALESCE(f.archived,false)');
  if (view === 'unread') where.push('(c.unread_count>0 OR COALESCE(f.marked_unread,false))');
  if (view === 'fav') where.push('COALESCE(f.favorite,false)');
  if (view === 'mine') where.push(`c.assigned_to=${me}`); // "Mine": the chats given to me (managers and admins in the rotation)
  if (req.query.label) { p.push(Number(req.query.label)); where.push(`EXISTS (SELECT 1 FROM conversation_labels cl WHERE cl.conversation_id=c.id AND cl.label_id=$${p.length})`); }
  if (q) { p.push(`%${q}%`); where.push(`(ct.name ILIKE $${p.length} OR ct.profile_name ILIKE $${p.length} OR ct.wa_id ILIKE $${p.length})`); }
  const { rows } = await query(
    `SELECT c.*, ct.wa_id, COALESCE(ct.profile_name, ct.name) AS contact_name, u.name AS agent_name, ${NUMBER_LABEL_SQL}, ${LABELS_SQL},
            COALESCE(f.pinned,false) AS pinned, COALESCE(f.favorite,false) AS favorite, COALESCE(f.archived,false) AS archived, COALESCE(f.marked_unread,false) AS marked_unread,
            (SELECT body FROM messages m WHERE m.conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_body,
            (SELECT type FROM messages m WHERE m.conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_type
       FROM conversations c JOIN contacts ct ON ct.id=c.contact_id LEFT JOIN users u ON u.id=c.assigned_to
       LEFT JOIN chat_flags f ON f.conversation_id=c.id AND f.user_id=${me}
      WHERE ${where.join(' AND ')} ORDER BY COALESCE(f.pinned,false) DESC, f.pinned_at DESC NULLS LAST, c.last_message_at DESC LIMIT 200`, p);
  res.json(rows.map(r => ({ ...r, ...windowInfo(r) })));
}));

// Pin / favourite / archive / mark unread: kept per person, like WhatsApp
router.post('/conversations/:id/flags', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  const me = req.user.id, b = req.body || {}, sets = [], vals = [me, c.id];
  if (b.pinned === true) {
    const n = (await query('SELECT COUNT(*)::int AS n FROM chat_flags WHERE user_id=$1 AND pinned AND conversation_id<>$2', [me, c.id])).rows[0].n;
    if (n >= 3) return res.status(409).json({ error: 'You can pin up to 3 chats. Unpin one first.' });
  }
  await query('INSERT INTO chat_flags(user_id,conversation_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [me, c.id]);
  for (const k of ['pinned', 'favorite', 'archived', 'marked_unread']) if (typeof b[k] === 'boolean') {
    vals.push(b[k]); sets.push(`${k}=$${vals.length}`);
    if (k === 'pinned') sets.push(b[k] ? 'pinned_at=now()' : 'pinned_at=NULL');
    if (k === 'archived' && b[k]) sets.push('pinned=false', 'pinned_at=NULL');
  }
  if (sets.length) await query(`UPDATE chat_flags SET ${sets.join(',')} WHERE user_id=$1 AND conversation_id=$2`, vals);
  res.json({ ok: true });
}));

router.get('/conversations/:id/messages', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  const before = req.query.before ? Number(req.query.before) : 9e15, lim = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 500);
  const { rows } = await query(
    `SELECT m.*, su.name AS agent_name, q.id AS q_id, q.body AS q_body, q.type AS q_type, q.sender_type AS q_sender, qu.name AS q_agent
       FROM messages m LEFT JOIN messages q ON q.wa_message_id = m.reply_to_wa_id AND q.conversation_id = m.conversation_id
       LEFT JOIN users qu ON qu.id = q.sender_id LEFT JOIN users su ON su.id = m.sender_id
      WHERE m.conversation_id=$1 AND m.id<$2 ORDER BY m.id DESC LIMIT ${lim}`, [c.id, before]);
  const notes = (await query(`SELECT n.*, u.name AS author FROM notes n JOIN users u ON u.id=n.user_id WHERE conversation_id=$1 ORDER BY n.id`, [c.id])).rows;
  const fl = (await query('SELECT pinned,favorite,archived,marked_unread FROM chat_flags WHERE user_id=$1 AND conversation_id=$2', [req.user.id, c.id])).rows[0] || {};
  res.json({ conversation: { ...c, ...windowInfo(c), pinned: !!fl.pinned, favorite: !!fl.favorite, archived: !!fl.archived, marked_unread: !!fl.marked_unread }, messages: rows.reverse(), notes });
}));

router.post('/conversations/:id/messages', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!windowInfo(c).window_open)
    return res.status(409).json({ error: 'The 24-hour reply window is closed. Send an approved template to reopen the chat.', code: 'WINDOW_CLOSED' });
  try {
    const ctx = await replyCtx(c.id, req.body.reply_to);
    const btns = (Array.isArray(req.body.buttons) ? req.body.buttons : []).map(x => String(x).trim().slice(0, 20)).filter(Boolean).slice(0, 3);
    const w = wa.forConversation(c);
    const r = btns.length ? await w.sendButtons(c.wa_id, text.slice(0, 1024), btns.map((t, i) => ({ id: 'qr_' + (i + 1), title: t }))) : await w.sendText(c.wa_id, text, ctx);
    const m = await saveOutbound(c, { senderType: 'agent', senderId: req.user.id, body: btns.length ? `${text}\n\n🔘 ${btns.join('  ·  ')}` : text, waMessageId: r.messages?.[0]?.id, replyTo: btns.length ? null : ctx });
    await query('UPDATE conversations SET unread_count=0, escalated_at=NULL WHERE id=$1', [c.id]);
    res.json(m);
  } catch (e) { res.status(502).json({ error: e.message }); }
}));

router.post('/conversations/:id/template', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  const t = (await query('SELECT * FROM templates WHERE name=$1 AND company_id=$2', [req.body.name, C()])).rows[0];
  if (!t) return res.status(404).json({ error: 'template not found' });
  if (t.status !== 'APPROVED' && process.env.WA_DRY_RUN !== 'true') return res.status(409).json({ error: 'Meta has not approved this template yet' });
  const params = t.var_count === 0 ? [] : (req.body.params?.length ? req.body.params : [(c.contact_name || 'there').split(' ')[0]]);
  try {
    const r = await wa.forConversation(c).sendTemplate(c.wa_id, t.name, t.language, params);
    const body = params.reduce((s, v, i) => s.replace(`{{${i + 1}}}`, v), t.body);
    const m = await saveOutbound(c, { senderType: 'agent', senderId: req.user.id, type: 'template', body, templateName: t.name, waMessageId: r.messages?.[0]?.id });
    res.json(m);
  } catch (e) { res.status(502).json({ error: e.message }); }
}));

router.post('/conversations/:id/read', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  await query('UPDATE conversations SET unread_count=0 WHERE id=$1', [c.id]);
  await query('UPDATE chat_flags SET marked_unread=FALSE WHERE user_id=$1 AND conversation_id=$2', [req.user.id, c.id]);
  if (c.unread_count > 0 && c.assigned_to === req.user.id) {
    const last = (await query(`SELECT wa_message_id FROM messages WHERE conversation_id=$1 AND direction='in' AND wa_message_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [c.id])).rows[0];
    if (last) wa.forConversation(c).markRead(last.wa_message_id); // blue ticks: the client sees that a person has read it
  }
  res.json({ ok: true });
}));

// "typing..." on the client's phone while the owning agent writes (at most once every 15 s per chat)
const typingAt = new Map();
router.post('/conversations/:id/typing', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  if (c.assigned_to !== req.user.id || !windowInfo(c).window_open || Date.now() - (typingAt.get(c.id) || 0) < 15000) return res.json({ ok: true, skipped: true });
  const last = (await query(`SELECT wa_message_id FROM messages WHERE conversation_id=$1 AND direction='in' AND wa_message_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [c.id])).rows[0];
  if (!last) return res.json({ ok: true, skipped: true });
  typingAt.set(c.id, Date.now());
  wa.forConversation(c).typing(last.wa_message_id).catch(() => {});
  res.json({ ok: true });
}));

router.post('/conversations/:id/notes', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  const { rows } = await query('INSERT INTO notes(conversation_id,user_id,body) VALUES($1,$2,$3) RETURNING *', [c.id, req.user.id, req.body.body]);
  res.json(rows[0]);
}));

router.post('/conversations/:id/status', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  if (!['open', 'closed'].includes(req.body.status)) return res.status(400).json({ error: 'bad status' });
  await query('UPDATE conversations SET status=$2 WHERE id=$1', [c.id, req.body.status]);
  if (req.body.status === 'closed') { await require('../flows').agentTookOver(c.id); await require('../ai').stop(c.id); } // a closed chat is no longer in a chatbot or with the AI
  res.json({ ok: true });
}));

// Managers: reassign (to a chosen agent, or auto-pick when agent_id omitted)
router.post('/conversations/:id/reassign', required('admin', 'manager'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query('SELECT team, bot_step FROM conversations WHERE id=$1 AND company_id=$2', [id, C()])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not found' });
  // A chat still with the chatbot or the AI: a person takes over, so the chatbot and the AI stop and it becomes a normal client chat.
  if (cur.bot_step !== 'held' && cur.bot_step !== 'done') {
    await require('../flows').agentTookOver(id); await require('../ai').stop(id);
    await query(`UPDATE conversations SET bot_step='done' WHERE id=$1 AND company_id=$2 AND bot_step NOT IN ('held','done')`, [id, C()]);
  }
  let conv;
  if (req.body.agent_id) {
    if (!(await query('SELECT 1 FROM users WHERE id=$1 AND company_id=$2', [Number(req.body.agent_id) || 0, C()])).rows[0]) return res.status(400).json({ error: 'Person not found' });
    conv = (await query(`UPDATE conversations SET assigned_to=$2, status='open', assigned_at=now() WHERE id=$1 AND company_id=$3 RETURNING *`, [id, req.body.agent_id, C()])).rows[0];
  } else {
    conv = await assignConversation(id, cur.team);
  }
  if (!conv) return res.status(409).json({ error: 'No agent available' });
  rt.toUser(conv.assigned_to, 'conversation:assigned', { conversationId: id });
  push.notifyUser(conv.assigned_to, 'Chat assigned to you', 'A manager assigned you a client.', { conversationId: id }, 'assigned');
  res.json(conv);
}));

// ---- Media ----
// Raw body upload: POST /conversations/:id/media?filename=..&mime=..&caption=..
router.post('/conversations/:id/media', express.raw({ type: () => true, limit: '16mb' }), required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  if (!windowInfo(c).window_open)
    return res.status(409).json({ error: 'The reply window is closed. Send an approved template first.', code: 'WINDOW_CLOSED' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'No file received' });
  let mime = String(req.query.mime || 'application/octet-stream').split(';')[0].trim();
  let filename = String(req.query.filename || 'file').slice(0, 120);
  const caption = String(req.query.caption || '').trim().slice(0, 1000);
  let body = buf;
  if (/^audio\//.test(mime) && !/^audio\/(aac|mp4|mpeg|amr)/.test(mime)) { // e.g. WebM or OGG from a browser recording
    try { body = await toMp3(buf); mime = 'audio/mpeg'; filename = 'voice-note.mp3'; } catch (e) { return res.status(422).json({ error: e.message }); }
  }
  const kind = mediaStore.kindOf(mime);
  if (kind === 'image' && buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'Photos must be under 5 MB' });
  try {
    const ctx = await replyCtx(c.id, req.query.reply_to);
    const w = wa.forConversation(c);
    const up = await w.uploadMedia(body, mime, filename);
    const sent = await w.sendMedia(c.wa_id, kind, up.id, { caption, filename, ctx });
    await mediaStore.store(up.id, mime, body);
    const m = await saveOutbound(c, { senderType: 'agent', senderId: req.user.id, type: kind, body: caption || `[${kind}]`,
      waMessageId: sent.messages?.[0]?.id, mediaId: up.id, mediaMime: mime, mediaName: filename, replyTo: ctx });
    await query('UPDATE conversations SET unread_count=0, escalated_at=NULL WHERE id=$1', [c.id]);
    res.json(m);
  } catch (e) { res.status(502).json({ error: e.message }); }
}));

router.get('/messages/:id/media', required(), wrap(async (req, res) => {
  const m = (await query(`SELECT m.*, c.assigned_to, c.wa_number_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=$1 AND c.company_id=$2`, [Number(req.params.id) || 0, C()])).rows[0];
  if (!m || !m.media_id) return res.status(404).json({ error: 'not found' });
  if (isAgent(req.user) && m.assigned_to !== req.user.id) return res.status(403).json({ error: 'not your conversation' });
  try {
    const f = await mediaStore.ensure(m.media_id, wa.forConversation(m));
    res.set({ 'Content-Type': f.mime || m.media_mime || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(m.media_name || 'file')}` });
    res.send(f.data);
  } catch (e) { res.status(404).json({ error: 'This file is no longer available' }); }
}));

// ---- Phone push tokens ----
router.post('/devices', required(), wrap(async (req, res) => {
  if (!req.body.token) return res.status(400).json({ error: 'token required' });
  await query(`INSERT INTO devices(user_id,token) VALUES($1,$2) ON CONFLICT (token) DO UPDATE SET user_id=EXCLUDED.user_id`, [req.user.id, req.body.token]);
  res.json({ ok: true });
}));
router.post('/devices/remove', required(), wrap(async (req, res) => {
  await query('DELETE FROM devices WHERE token=$1 AND user_id=$2', [req.body.token, req.user.id]); res.json({ ok: true });
}));

// ---- Departments (admin adds, renames and removes them) ----
router.get('/departments', required(), wrap(async (req, res) => res.json((await query(
  `SELECT d.id, d.key, d.name, (SELECT COUNT(*) FROM users u WHERE (u.team=d.key OR u.extra_teams ? d.key) AND u.company_id=d.company_id)::int AS members FROM departments d WHERE d.company_id=$1 ORDER BY d.name`, [C()])).rows)));
router.post('/departments', required('admin'), wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40); if (!name) return res.status(400).json({ error: 'Give the department a name' });
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30); if (!key) return res.status(400).json({ error: 'Use letters or numbers in the name' });
  if ((await query('SELECT 1 FROM departments WHERE company_id=$3 AND (key=$1 OR lower(name)=lower($2))', [key, name, C()])).rows[0]) return res.status(409).json({ error: 'A department with this name already exists' });
  res.json((await query('INSERT INTO departments(company_id,key,name) VALUES($3,$1,$2) RETURNING *', [key, name, C()])).rows[0]);
}));
router.patch('/departments/:id', required('admin'), wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40); if (!name) return res.status(400).json({ error: 'Give the department a name' });
  await query('UPDATE departments SET name=$2 WHERE id=$1 AND company_id=$3', [req.params.id, name, C()]); res.json({ ok: true });
}));
router.delete('/departments/:id', required('admin'), wrap(async (req, res) => {
  const d = (await query('SELECT * FROM departments WHERE id=$1 AND company_id=$2', [req.params.id, C()])).rows[0]; if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.key === 'general') return res.status(409).json({ error: 'The General department cannot be removed' });
  const used = (await query(`SELECT (SELECT COUNT(*) FROM users WHERE team=$1 AND company_id=$2)::int AS u, (SELECT COUNT(*) FROM conversations WHERE team=$1 AND company_id=$2 AND status IN ('open','bot'))::int AS c`, [d.key, C()])).rows[0];
  const routing = await settings.get('routing');
  if (Object.values(routing).includes(d.key)) return res.status(409).json({ error: 'The bot sends clients to this department. Pick another one in "Chat assignment" first.' });
  if (used.u || used.c) return res.status(409).json({ error: `${used.u} team member(s) and ${used.c} open chat(s) use this department. Move them first.` });
  await query('UPDATE users SET extra_teams = extra_teams - $1::text WHERE company_id=$2 AND extra_teams ? $1', [d.key, C()]); // people who only had it as an extra department
  await query('DELETE FROM departments WHERE id=$1 AND company_id=$2', [d.id, C()]); res.json({ ok: true });
}));

// ---- Admin: users, templates, stats ----
router.get('/users', required('admin', 'manager'), wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id,u.name,u.email,u.role,u.team,u.extra_teams,u.is_active,u.is_online,u.in_rotation,u.max_active_chats,
            (SELECT COUNT(*) FROM conversations c WHERE c.assigned_to=u.id AND c.status='open')::int AS active_chats
       FROM users u WHERE u.company_id=$1 ORDER BY u.id`, [C()]);
  res.json(rows);
}));
router.post('/users', required('admin'), wrap(async (req, res) => {
  const { name, email, password, role = 'agent', team = 'general', max_active_chats = 150 } = req.body;
  const em = String(email || '').trim().toLowerCase();
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Enter a name' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'The password must be at least 6 characters' });
  if (!['admin', 'manager', 'agent'].includes(role)) return res.status(400).json({ error: 'Unknown role' });
  if ((await query('SELECT 1 FROM users WHERE email=$1', [em])).rows[0]) return res.status(409).json({ error: 'That email is already used by someone else' });
  const over = await plan.check('members'); if (over) return res.status(402).json({ error: over });
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO users(company_id,name,email,password_hash,role,team,max_active_chats,in_rotation) VALUES($7,$1,$2,$3,$4,$5,$6,$8) RETURNING id,name,email,role,team`,
    [String(name).trim(), em, hash, role, team, max_active_chats, C(), role === 'agent']); // managers and admins join the rotation only when switched on
  res.json(rows[0]);
}));
router.patch('/users/:id', required('admin'), wrap(async (req, res) => {
  const uid = Number(req.params.id), b = req.body;
  const target = (await query('SELECT role, is_active, team FROM users WHERE id=$1 AND company_id=$2', [uid, C()])).rows[0];
  if (!target) return res.status(404).json({ error: 'Person not found' });
  if ('email' in b) {
    const em = String(b.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).json({ error: 'Enter a valid email address' });
    if ((await query('SELECT 1 FROM users WHERE email=$1 AND id<>$2', [em, uid])).rows[0]) return res.status(409).json({ error: 'That email is already used by someone else' });
    b.email = em;
  }
  if ('role' in b && !['admin', 'manager', 'agent'].includes(b.role)) return res.status(400).json({ error: 'Unknown role' });
  if (b.is_active === true && !target.is_active) { const over = await plan.check('members'); if (over) return res.status(402).json({ error: over }); }
  const losingAdmin = target.role === 'admin' && target.is_active && (b.is_active === false || ('role' in b && b.role !== 'admin'));
  if (losingAdmin && (await query(`SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND is_active AND id<>$1 AND company_id=$2`, [uid, C()])).rows[0].n === 0)
    return res.status(409).json({ error: 'There must always be one active admin. Add another admin first.' });
  // Changing the email, password, role or active state signs that person out everywhere
  if ('email' in b || b.password || 'role' in b || b.is_active === false) {
    await query('UPDATE users SET session_version = session_version + 1 WHERE id=$1', [uid]); require('../auth').forget(uid);
    if ('email' in b) await query('UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [uid]);
  }
  const f = ['name', 'email', 'role', 'team', 'is_active', 'max_active_chats', 'in_rotation'].filter(k => k in req.body);
  if ('team' in req.body && !(await query('SELECT 1 FROM departments WHERE key=$1 AND company_id=$2', [req.body.team, C()])).rows[0]) return res.status(400).json({ error: 'Unknown department' });
  if ('extra_teams' in b) { // more departments this person takes chats from, besides the main one
    const keys = [...new Set((Array.isArray(b.extra_teams) ? b.extra_teams : []).map(String))].filter(k => k !== ('team' in b ? b.team : target.team));
    const known = keys.length ? (await query('SELECT key FROM departments WHERE company_id=$1 AND key = ANY($2::text[])', [C(), keys])).rows.map(r => r.key) : [];
    if (known.length !== keys.length) return res.status(400).json({ error: 'Unknown department' });
    await query('UPDATE users SET extra_teams=$2::jsonb WHERE id=$1', [uid, JSON.stringify(keys)]);
  }
  if (req.body.password && String(req.body.password).length < 8) return res.status(400).json({ error: 'The password must be at least 8 characters' });
  if (req.body.password) { await query('UPDATE users SET password_hash=$2 WHERE id=$1', [uid, await bcrypt.hash(req.body.password, 10)]); }
  if ('in_rotation' in req.body) req.body.in_rotation = req.body.in_rotation === true;
  if (f.length) await query(`UPDATE users SET ${f.includes('team') ? 'extra_teams = extra_teams - $' + (f.indexOf('team') + 2) + '::text, ' : ''}${f.map((k, i) => `${k}=$${i + 2}`).join(',')}${f.includes('in_rotation') ? ', rotation_changed_at=now()' : ''} WHERE id=$1`, [uid, ...f.map(k => req.body[k])]);
  res.json({ ok: true });
}));

router.get('/templates', required(), wrap(async (req, res) => res.json((await query('SELECT * FROM templates WHERE company_id=$1 ORDER BY name', [C()])).rows)));


router.get('/stats', required('admin', 'manager'), wrap(async (req, res) => {
  const totals = (await query(`SELECT
      COUNT(*) FILTER (WHERE status='open')::int AS open,
      COUNT(*) FILTER (WHERE status='closed')::int AS closed,
      COUNT(*) FILTER (WHERE status='bot')::int AS with_bot,
      COUNT(*) FILTER (WHERE assigned_to IS NULL AND bot_step='done')::int AS unassigned,
      COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS new_24h FROM conversations WHERE company_id=$1`, [C()])).rows[0];
  const agents = (await query(`SELECT u.id,u.name,u.team,u.is_online,
      COUNT(c.id) FILTER (WHERE c.status='open')::int AS open_chats,
      COALESCE(SUM(c.unread_count),0)::int AS unread
      FROM users u LEFT JOIN conversations c ON c.assigned_to=u.id WHERE (u.role='agent' OR u.in_rotation) AND u.company_id=$1 GROUP BY u.id ORDER BY u.name`, [C()])).rows;
  res.json({ totals, agents });
}));

// ---- Not a client / held senders ----
router.post('/conversations/:id/not-client', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  await markPersonal(c.contact_id); res.json({ ok: true });
}));
router.post('/conversations/:id/release', required('admin', 'manager'), wrap(async (req, res) => {
  const c = (await query(`UPDATE conversations SET status='bot', bot_step='new' WHERE id=$1 AND company_id=$2 AND bot_step='held' RETURNING *`, [Number(req.params.id) || 0, C()])).rows[0];
  if (!c) return res.status(404).json({ error: 'This chat is not on hold' });
  const contact = (await query('SELECT * FROM contacts WHERE id=$1', [c.contact_id])).rows[0];
  await bot.handle(c, contact, { type: 'text', body: '' }); res.json({ ok: true });
}));

// ---- Settings: bot wording and away message ----
router.get('/settings', required('admin', 'manager'), wrap(async (req, res) => res.json({ bot: await settings.get('bot'), away: await settings.get('away'), gate: await settings.get('gate'), assign: await settings.get('assign'), routing: await settings.get('routing') })));
router.put('/settings/:key', required('admin', 'manager'), wrap(async (req, res) => {
  const k = req.params.key, b = req.body || {};
  if (k === 'bot') {
    const v = {};
    for (const f of ['greet', 'askName', 'handoff', 'btnInfo', 'btnTeam', 'btnClasses'])
      if (typeof b[f] === 'string' && b[f].trim()) v[f] = b[f].trim().slice(0, f.startsWith('btn') ? 20 : 600);
    await settings.set('bot', { ...(await settings.get('bot')), ...v });
  } else if (k === 'away') {
    const cur = await settings.get('away');
    const days = Array.isArray(b.days) ? b.days.map(Number).filter(n => n >= 0 && n <= 6) : cur.days;
    await settings.set('away', { ...cur, enabled: !!b.enabled, message: String(b.message || cur.message).slice(0, 600), days,
      start: /^\d\d:\d\d$/.test(b.start) ? b.start : cur.start, end: /^\d\d:\d\d$/.test(b.end) ? b.end : cur.end });
  } else if (k === 'gate') {
    const kw = (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(',')).map(x => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 50);
    await settings.set('gate', { mode: b.mode === 'keywords' ? 'keywords' : 'all', keywords: kw });
  } else if (k === 'assign') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can change this' });
    const cur = await settings.get('assign');
    await settings.set('assign', { mode: b.mode === 'turns' ? 'turns' : 'least', batch: Math.min(20, Math.max(1, Math.round(Number(b.batch)) || 1)),
      slow_since: b.slow_on === true && !cur.slow_on ? new Date().toISOString() : cur.slow_since || null,
      slow_on: 'slow_on' in b ? b.slow_on === true : cur.slow_on, slow_min: 'slow_min' in b ? Math.min(120, Math.max(2, Math.round(Number(b.slow_min)) || 10)) : cur.slow_min });
  } else if (k === 'routing') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can change this' });
    const keys = new Set((await query('SELECT key FROM departments WHERE company_id=$1', [C()])).rows.map(r => r.key)), v = {};
    for (const f of ['info', 'team', 'classes']) { if (b[f] !== undefined) { if (!keys.has(b[f])) return res.status(400).json({ error: 'Unknown department' }); v[f] = b[f]; } }
    await settings.set('routing', { ...(await settings.get('routing')), ...v });
  } else return res.status(404).json({ error: 'unknown setting' });
  res.json({ ok: true });
}));

// ---- Quick replies ----
router.get('/quick-replies', required(), wrap(async (req, res) => res.json((await query('SELECT id,shortcut,title,body,buttons FROM quick_replies WHERE company_id=$1 ORDER BY shortcut', [C()])).rows)));
router.post('/quick-replies', required('admin', 'manager'), wrap(async (req, res) => {
  const { shortcut, title, body } = req.body;
  if (!shortcut || !title || !body) return res.status(400).json({ error: 'Shortcut, title and text are required' });
  const btns = (Array.isArray(req.body.buttons) ? req.body.buttons : String(req.body.buttons || '').split(',')).map(x => String(x).trim().slice(0, 20)).filter(Boolean).slice(0, 3);
  res.json((await query('INSERT INTO quick_replies(company_id,shortcut,title,body,buttons) VALUES($5,$1,$2,$3,$4) RETURNING *',
    [String(shortcut).trim().replace(/^\/+/, '').slice(0, 30).replace(/\s+/g, '-'), String(title).slice(0, 80), String(body).slice(0, 1000), btns.length ? JSON.stringify(btns) : null, C()])).rows[0]);
}));
router.delete('/quick-replies/:id', required('admin', 'manager'), wrap(async (req, res) => { await query('DELETE FROM quick_replies WHERE id=$1 AND company_id=$2', [req.params.id, C()]); res.json({ ok: true }); }));

// ---- Labels ----
router.get('/labels', required(), wrap(async (req, res) => res.json((await query('SELECT * FROM labels WHERE company_id=$1 ORDER BY name', [C()])).rows)));
router.post('/labels', required('admin', 'manager'), wrap(async (req, res) => {
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color) ? req.body.color : '#0e5a4a';
  res.json((await query('INSERT INTO labels(company_id,name,color) VALUES($3,$1,$2) RETURNING *', [String(req.body.name || '').trim().slice(0, 30), color, C()])).rows[0]);
}));
router.delete('/labels/:id', required('admin', 'manager'), wrap(async (req, res) => { await query('DELETE FROM labels WHERE id=$1 AND company_id=$2', [req.params.id, C()]); res.json({ ok: true }); }));
router.post('/conversations/:id/labels', required(), wrap(async (req, res) => {
  const c = await loadConversation(req, res); if (!c) return;
  const lid = Number(req.body.label_id);
  if (!(await query('SELECT 1 FROM labels WHERE id=$1 AND company_id=$2', [lid || 0, C()])).rows[0]) return res.status(404).json({ error: 'Label not found' });
  if (req.body.on) await query('INSERT INTO conversation_labels VALUES($1,$2) ON CONFLICT DO NOTHING', [c.id, lid]);
  else await query('DELETE FROM conversation_labels WHERE conversation_id=$1 AND label_id=$2', [c.id, lid]);
  res.json({ ok: true });
}));

router.get('/analytics', required('admin', 'manager'), wrap(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 14, 1), 90), d = String(days);
  const tz = process.env.REPORT_TZ || 'Asia/Karachi';
  const since = `now() - ($1 || ' days')::interval`, cid = Number(C()); // cid is a number from the database
  const [kpi, perDay, intents, sources, agents, msgs, med] = await Promise.all([
    query(`SELECT COUNT(*) FILTER (WHERE created_at > ${since})::int AS new_chats,
        COUNT(*) FILTER (WHERE status='open')::int AS open,
        COUNT(*) FILTER (WHERE assigned_to IS NULL AND bot_step='done')::int AS unassigned,
        COUNT(*) FILTER (WHERE status='bot')::int AS with_bot,
        COUNT(*) FILTER (WHERE status='closed')::int AS closed,
        (SELECT COUNT(*) FROM slow_replies WHERE company_id=${cid} AND created_at > ${since})::int AS late,
        (SELECT COUNT(*) FROM demo_bookings WHERE company_id=${cid} AND created_at > ${since} AND status <> 'moved')::int AS demo FROM conversations WHERE company_id=${cid}`, [d]),
    query(`SELECT to_char(g,'YYYY-MM-DD') AS day, COALESCE(x.n,0)::int AS chats
        FROM generate_series(((now() AT TIME ZONE $2)::date - ($1::int - 1))::timestamp, (now() AT TIME ZONE $2)::date::timestamp, interval '1 day') g
        LEFT JOIN (SELECT (created_at AT TIME ZONE $2)::date AS dd, COUNT(*) AS n FROM conversations WHERE company_id=${cid} GROUP BY 1) x ON x.dd = g::date ORDER BY g`, [days, tz]),
    query(`SELECT COALESCE(intent,'unknown') AS k, COUNT(*)::int AS n FROM conversations WHERE company_id=${cid} AND created_at > ${since} GROUP BY 1 ORDER BY n DESC`, [d]),
    query(`SELECT COALESCE(ct.source,'organic') AS k, COUNT(*)::int AS n FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.company_id=${cid} AND c.created_at > ${since} GROUP BY 1 ORDER BY n DESC`, [d]),
    query(`SELECT u.id, u.name, u.team, COUNT(c.id)::int AS assigned, COUNT(c.first_reply)::int AS replied,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (c.first_reply - c.assigned_at))) AS median_reply_sec,
        (SELECT COUNT(*) FROM messages m WHERE m.sender_id=u.id AND m.sender_type='agent' AND m.created_at > ${since})::int AS msgs_sent,
        (SELECT COUNT(*) FROM conversations o WHERE o.assigned_to=u.id AND o.status='open')::int AS open_now,
        (SELECT COALESCE(SUM(unread_count),0) FROM conversations o WHERE o.assigned_to=u.id)::int AS unread
      FROM users u LEFT JOIN LATERAL (
        SELECT c2.id, c2.assigned_at, (SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id=c2.id AND m.sender_type='agent' AND m.created_at >= c2.assigned_at) AS first_reply
        FROM conversations c2 WHERE c2.assigned_to=u.id AND c2.assigned_at > ${since}) c ON TRUE
      WHERE u.company_id=${cid} AND (u.role='agent' OR u.in_rotation) AND u.is_active GROUP BY u.id ORDER BY assigned DESC, u.name`, [d]),
    query(`SELECT COUNT(*) FILTER (WHERE m.direction='in')::int AS inbound, COUNT(*) FILTER (WHERE m.sender_type='agent')::int AS agent_out,
        COUNT(*) FILTER (WHERE m.sender_type='bot')::int AS bot_out FROM messages m JOIN conversations cv ON cv.id=m.conversation_id WHERE cv.company_id=${cid} AND m.created_at > ${since}`, [d]),
    query(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (fr - assigned_at))) AS sec FROM (
        SELECT assigned_at, (SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id=c.id AND m.sender_type='agent' AND m.created_at >= c.assigned_at) AS fr
        FROM conversations c WHERE c.company_id=${cid} AND assigned_at > ${since}) t WHERE fr IS NOT NULL`, [d])
  ]);
  res.json({ days, kpi: kpi.rows[0], perDay: perDay.rows, intents: intents.rows, sources: sources.rows, agents: agents.rows, messages: msgs.rows[0], median_reply_sec: med.rows[0].sec });
}));

module.exports = router;
module.exports.clientSites = clientSites;
