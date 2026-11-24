const crypto = require('crypto');
const { pool, query } = require('./db');

// Access tokens saved from Settings are encrypted with a key derived from WA_TOKEN_KEY (or JWT_SECRET).
const keyOf = () => crypto.createHash('sha256').update(process.env.WA_TOKEN_KEY || process.env.JWT_SECRET || 'wa-crm').digest();
function encrypt(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keyOf(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(s) {
  if (!s) return null;
  if (!s.startsWith('enc:')) return s;
  try {
    const b = Buffer.from(s.slice(4), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', keyOf(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}

const tenant = require('./tenant');
const C = () => tenant.cid();
const PUBLIC = `id, label, phone_number_id, display_phone, verified_name, waba_id, is_default, calls_enabled, created_at, (access_token IS NOT NULL AND access_token <> '') AS has_token`;
const list = async () => (await query(`SELECT ${PUBLIC}, (SELECT COUNT(*)::int FROM conversations c WHERE c.wa_number_id=n.id) AS chats FROM wa_numbers n WHERE n.company_id=$1 ORDER BY is_default DESC, id`, [C()])).rows;
const count = async () => (await query('SELECT COUNT(*)::int AS n FROM wa_numbers WHERE company_id=$1', [C()])).rows[0].n;
// Used by the webhook before the company is known: a Meta phone number ID belongs to exactly one company.
const byPhoneId = async (pid) => (await query('SELECT id, label, company_id FROM wa_numbers WHERE phone_number_id=$1', [String(pid)])).rows[0] || null;
const get = async (id) => (await query('SELECT * FROM wa_numbers WHERE id=$1 AND company_id=$2', [id, C()])).rows[0] || null;
const getDefault = async () => (await query('SELECT * FROM wa_numbers WHERE is_default AND company_id=$1', [C()])).rows[0] || null;

// The number to use for a conversation or broadcast. Falls back to the company's default number.
// Only company 1 (the original setup) may fall back to the old WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN server settings.
async function resolve(id) {
  const cid = C();
  let row = id ? await get(id) : null;
  if (!row) row = await getDefault();
  if (!row) {
    if (cid !== 1 || !process.env.WA_PHONE_NUMBER_ID) throw new Error('No WhatsApp number is set up yet. Open Settings, WhatsApp numbers, and add one.');
    return { id: null, label: 'Main', phone_number_id: process.env.WA_PHONE_NUMBER_ID, token: process.env.WA_ACCESS_TOKEN, waba_id: process.env.WA_WABA_ID || '' };
  }
  let token = cid === 1 ? process.env.WA_ACCESS_TOKEN : null;
  if (row.access_token) {
    token = decrypt(row.access_token);
    if (!token) throw new Error(`The saved access token for "${row.label}" cannot be read (the server secret changed). Open Settings, WhatsApp numbers, and enter the token again.`);
  }
  if (!token) throw new Error(`No access token is saved for "${row.label}". Open Settings, WhatsApp numbers, and add it.`);
  return { id: row.id, label: row.label, phone_number_id: row.phone_number_id, token, waba_id: row.waba_id || '' };
}

async function add({ label, phone_number_id, token, waba_id, display_phone, verified_name, make_default }) {
  const cid = C();
  const first = (await count()) === 0;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const asDefault = first || !!make_default;
    if (asDefault) await c.query('UPDATE wa_numbers SET is_default=FALSE WHERE is_default AND company_id=$1', [cid]);
    const r = await c.query(
      `INSERT INTO wa_numbers(company_id,label,phone_number_id,display_phone,verified_name,access_token,waba_id,is_default) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${PUBLIC}`,
      [cid, label, phone_number_id, display_phone || null, verified_name || null, token ? encrypt(token) : null, waba_id || null, asDefault]);
    await c.query('COMMIT');
    return r.rows[0];
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

async function makeDefault(id) {
  const cid = C();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('UPDATE wa_numbers SET is_default=FALSE WHERE is_default AND company_id=$1', [cid]);
    await c.query('UPDATE wa_numbers SET is_default=TRUE WHERE id=$1 AND company_id=$2', [id, cid]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

// First start after upgrading: the number from WA_PHONE_NUMBER_ID becomes company 1's default number automatically.
async function importFromEnv() {
  const pid = process.env.WA_PHONE_NUMBER_ID;
  if (!pid) return;
  return tenant.run(1, async () => {
    if ((await count()) > 0 || await byPhoneId(pid)) return;
    const n = await add({ label: 'Main number', phone_number_id: pid, waba_id: process.env.WA_WABA_ID || null, make_default: true });
    await query('UPDATE conversations SET wa_number_id=$1 WHERE wa_number_id IS NULL AND company_id=1', [n.id]);
    console.log('Imported WA_PHONE_NUMBER_ID as the default WhatsApp number');
  });
}

module.exports = { encrypt, decrypt, list, count, byPhoneId, get, getDefault, resolve, add, makeDefault, importFromEnv };
