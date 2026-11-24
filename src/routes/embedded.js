// "Connect WhatsApp" button (Meta Embedded Signup).
// A client signs in with Facebook in a popup, picks or creates their WhatsApp Business account and number,
// and Meta gives us a one-time code. Here we swap that code for a token, save the number (token encrypted),
// register it for the Cloud API and point its messages to this server's /webhook.
// Turned on only when META_APP_ID, META_CONFIG_ID and META_APP_SECRET are set on the server.
const express = require('express');
const { query } = require('../db');
const { required } = require('../auth');
const tenant = require('../tenant');
const numbers = require('../numbers');
const router = express.Router();
const admin = required('admin');
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });

const VERSION = () => process.env.WA_API_VERSION || 'v21.0';
const GRAPH = () => `${process.env.GRAPH_BASE || 'https://graph.facebook.com'}/${VERSION()}`;
const digits = (x) => String(x || '').replace(/\D/g, '');
const enabled = () => !!(process.env.META_APP_ID && process.env.META_CONFIG_ID && process.env.META_APP_SECRET);

async function graph(path, { token, method = 'GET', body } = {}) {
  const r = await fetch(`${GRAPH()}/${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.error_user_msg || d?.error?.message || `Meta request failed (${r.status})`);
  return d;
}

// The page asks this first: show the button only when the server is set up for it. No secret is sent to the browser.
router.get('/whatsapp/embedded-config', admin, (req, res) => {
  if (!enabled()) return res.json({ enabled: false });
  res.json({ enabled: true, app_id: process.env.META_APP_ID, config_id: process.env.META_CONFIG_ID, version: VERSION() });
});

router.post('/whatsapp/embedded-signup', admin, wrap(async (req, res) => {
  if (!enabled()) return res.status(400).json({ error: 'The Connect WhatsApp button is not set up on this server yet.' });
  if (process.env.WA_DRY_RUN === 'true') return res.status(400).json({ error: 'The server is in test mode (WA_DRY_RUN=true), so it cannot connect a real number.' });
  const code = String(req.body.code || '').trim();
  const pin = digits(req.body.pin);
  let pid = digits(req.body.phone_number_id), waba = digits(req.body.waba_id);
  if (!code) return res.status(400).json({ error: 'Meta did not send a sign-in code. Please try the button again.' });
  if (pin.length !== 6) return res.status(400).json({ error: 'The PIN must be exactly 6 digits.' });

  // 1. Swap the one-time code for this business's own access token
  const qs = new URLSearchParams({ client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, code });
  let token;
  try { token = (await graph(`oauth/access_token?${qs}`)).access_token; }
  catch (e) { return res.status(400).json({ error: 'Meta did not accept the sign-in: ' + e.message }); }
  if (!token) return res.status(400).json({ error: 'Meta did not return an access token. Please try again.' });

  // 2. If the popup did not tell us the account or number, ask Meta which ones this token was given
  if (!waba) {
    try {
      const dbg = await graph(`debug_token?input_token=${encodeURIComponent(token)}`, { token: `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}` });
      const scope = (dbg.data?.granular_scopes || []).find(s => s.scope === 'whatsapp_business_management');
      waba = digits(scope?.target_ids?.[0]);
    } catch (e) { /* handled below */ }
  }
  if (!waba) return res.status(400).json({ error: 'Could not find the WhatsApp Business account that was shared. Please try again and finish every step in the popup.' });
  if (!pid) {
    const list = (await graph(`${waba}/phone_numbers?fields=id,display_phone_number`, { token })).data || [];
    if (list.length !== 1) return res.status(400).json({ error: list.length ? 'This account has several numbers. Please run the button again and pick one number in the popup.' : 'This WhatsApp account has no phone number yet. Add one in the popup.' });
    pid = digits(list[0].id);
  }

  // 3. Read the number's details (this also proves the token works for it)
  let info;
  try { info = await graph(`${pid}?fields=display_phone_number,verified_name`, { token }); }
  catch (e) { return res.status(400).json({ error: 'Meta did not let us read this number: ' + e.message }); }

  // 4. Register the number for sending and receiving (sets the two-step PIN). Already registered numbers just keep working.
  const warnings = [];
  try { await graph(`${pid}/register`, { token, method: 'POST', body: { messaging_product: 'whatsapp', pin } }); }
  catch (e) { warnings.push('Meta did not register the number: ' + e.message + ' (If this number already has a two-step PIN, run the button again with that PIN.)'); }

  // 5. Send this account's messages to this server's webhook
  const base = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  const sub = base && process.env.WA_VERIFY_TOKEN ? { override_callback_uri: `${base}/webhook`, verify_token: process.env.WA_VERIFY_TOKEN } : undefined;
  let subscribed = false;
  try { await graph(`${waba}/subscribed_apps`, { token, method: 'POST', body: sub }); subscribed = true; }
  catch (e) { warnings.push('Meta did not confirm message delivery to this server: ' + e.message); }

  // 6. Save it. A number that is already here gets the new token instead of a second copy.
  // A number belongs to one company only: another company cannot take it over by connecting it again.
  const existing = await numbers.byPhoneId(pid);
  if (existing && existing.company_id !== tenant.cid()) return res.status(409).json({ error: 'This number is already connected to another account. Contact support if it is yours.' });
  let row;
  if (existing) {
    await query('UPDATE wa_numbers SET access_token=$2, waba_id=$3, display_phone=$4, verified_name=$5 WHERE id=$1 AND company_id=$6',
      [existing.id, numbers.encrypt(token), waba, info.display_phone_number || null, info.verified_name || null, tenant.cid()]);
    row = { id: existing.id, label: existing.label, updated: true };
  } else {
    const over = await require('../plan').check('numbers'); if (over) return res.status(402).json({ error: over });
    const label = String(req.body.label || info.verified_name || 'WhatsApp').trim().slice(0, 40) || 'WhatsApp';
    row = await numbers.add({ label, phone_number_id: pid, token, waba_id: waba, display_phone: info.display_phone_number, verified_name: info.verified_name, make_default: false });
  }
  res.json({ ok: true, number: { ...row, display_phone: info.display_phone_number, verified_name: info.verified_name }, subscribed, warnings });
}));

module.exports = router;
