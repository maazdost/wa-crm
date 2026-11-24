const bcrypt = require('bcryptjs');
const { pool, query } = require('./db');

// Starting setup for a brand-new company: departments, neutral bot wording, and where each bot button sends clients.
const DEPARTMENTS = [['general', 'General'], ['sales', 'Sales'], ['support', 'Support']];
const startSettings = (company) => ({
  bot: {
    greet: `Hello! Welcome to ${company}. How can we help you today?`,
    askName: 'Great! May I know your name please?',
    handoff: 'Thank you {{name}}! One of our team will message you shortly.',
    btnInfo: 'More info', btnTeam: 'Talk to sales', btnClasses: 'Get support'
  },
  routing: { info: 'sales', team: 'sales', classes: 'support' },
  assign: { mode: 'least', batch: 1 }
});

// Creates a company and its first admin in one go. Either both are created or neither is.
async function create({ company, name, email, password }) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const co = (await c.query('INSERT INTO companies(name) VALUES($1) RETURNING *', [company])).rows[0];
    const u = (await c.query(
      `INSERT INTO users(company_id,name,email,password_hash,role,team) VALUES($1,$2,$3,$4,'admin','general') RETURNING *`,
      [co.id, name, email, await bcrypt.hash(password, 10)])).rows[0];
    for (const [key, label] of DEPARTMENTS)
      await c.query('INSERT INTO departments(company_id,key,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [co.id, key, label]);
    for (const [key, value] of Object.entries(startSettings(company)))
      await c.query('INSERT INTO settings(company_id,key,value) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [co.id, key, value]);
    await c.query('COMMIT');
    return { company: co, user: u };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

const list = async () => (await query(
  `SELECT co.id, co.name, co.status, co.created_at,
          (SELECT COUNT(*)::int FROM users u WHERE u.company_id=co.id) AS users,
          (SELECT COUNT(*)::int FROM wa_numbers n WHERE n.company_id=co.id) AS numbers,
          (SELECT COUNT(*)::int FROM conversations c WHERE c.company_id=co.id) AS chats,
          (SELECT MAX(c.last_message_at) FROM conversations c WHERE c.company_id=co.id) AS last_activity,
          (SELECT u.email FROM users u WHERE u.company_id=co.id AND u.role='admin' ORDER BY u.id LIMIT 1) AS admin_email
     FROM companies co ORDER BY co.id`)).rows;

module.exports = { create, list };
