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

const PUBLIC = `id, label, phone_number_id, display_phone, verified_name, waba_id, is_default, calls_enabled, created_at, (access_token IS NOT NULL AND access_token <> '') AS has_token`;
const list = async () => (await query(`SELECT ${PUBLIC}, (SELECT COUNT(*)::int FROM conversations c WHERE c.wa_number_id=n.id) AS chats FROM wa_numbers n ORDER BY is_default DESC, id`)).rows;
const count = async () => (await query('SELECT COUNT(*)::int AS n FROM wa_numbers')).rows[0].n;
const byPhoneId = async (pid) => (await query('SELECT id, label FROM wa_numbers WHERE phone_number_id=$1', [String(pid)])).rows[0] || null;

// The number to use for a conversation or broadcast. Falls back to the default number, then to the old WA_PHONE_NUMBER_ID setting.
async function resolve(id) {
  let row = id ? (await query('SELECT * FROM wa_numbers WHERE id=$1', [id])).rows[0] : null;
  if (!row) row = (await query('SELECT * FROM wa_numbers WHERE is_default')).rows[0];
  if (!row) {
    if (!process.env.WA_PHONE_NUMBER_ID) throw new Error('No WhatsApp number is set up yet. Open Settings, WhatsApp numbers, and add one.');
    return { id: null, label: 'Main', phone_number_id: process.env.WA_PHONE_NUMBER_ID, token: process.env.WA_ACCESS_TOKEN, waba_id: process.env.WA_WABA_ID || '' };
  }
  let token = process.env.WA_ACCESS_TOKEN;
  if (row.access_token) {
    token = decrypt(row.access_token);
    if (!token) throw new Error(`The saved access token for "${row.label}" cannot be read (the server secret changed). Open Settings, WhatsApp numbers, and enter the token again.`);
  }
  return { id: row.id, label: row.label, phone_number_id: row.phone_number_id, token, waba_id: row.waba_id || '' };
}

async function add({ label, phone_number_id, token, waba_id, display_phone, verified_name, make_default }) {
  const first = (await count()) === 0;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const asDefault = first || !!make_default;
    if (asDefault) await c.query('UPDATE wa_numbers SET is_default=FALSE WHERE is_default');
    const r = await c.query(
      `INSERT INTO wa_numbers(label,phone_number_id,display_phone,verified_name,access_token,waba_id,is_default) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${PUBLIC}`,
      [label, phone_number_id, display_phone || null, verified_name || null, token ? encrypt(token) : null, waba_id || null, asDefault]);
    await c.query('COMMIT');
    return r.rows[0];
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

async function makeDefault(id) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('UPDATE wa_numbers SET is_default=FALSE WHERE is_default');
    await c.query('UPDATE wa_numbers SET is_default=TRUE WHERE id=$1', [id]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

// First start after upgrading: the number from WA_PHONE_NUMBER_ID becomes the default number automatically.
async function importFromEnv() {
  const pid = process.env.WA_PHONE_NUMBER_ID;
  if (!pid || (await count()) > 0) return;
  const n = await add({ label: 'Main number', phone_number_id: pid, waba_id: process.env.WA_WABA_ID || null, make_default: true });
  await query('UPDATE conversations SET wa_number_id=$1 WHERE wa_number_id IS NULL', [n.id]);
  console.log('Imported WA_PHONE_NUMBER_ID as the default WhatsApp number');
}

module.exports = { encrypt, decrypt, list, count, byPhoneId, resolve, add, makeDefault, importFromEnv };
