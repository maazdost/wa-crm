const bcrypt = require('bcryptjs');
const { query } = require('./db');
// On the very first start (no users yet) create the admin login from ADMIN_EMAIL / ADMIN_PASSWORD.
module.exports = async function ensureAdmin() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;
  if ((await query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n > 0) return;
  await query(`INSERT INTO users(name,email,password_hash,role,team) VALUES($1,$2,$3,'admin','general')`,
    [ADMIN_NAME || 'Admin', ADMIN_EMAIL.toLowerCase(), await bcrypt.hash(ADMIN_PASSWORD, 10)]);
  await query(`INSERT INTO templates(name,language,body,category)
    VALUES('followup_interest','en','Hi {{1}}, are you still interested? Reply here and we will continue.','utility') ON CONFLICT (name) DO NOTHING`);
  console.log('Created first admin:', ADMIN_EMAIL);
};
