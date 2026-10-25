const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { migrate } = require('./migrate');
(async () => {
  await migrate();
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  await pool.query(
    `INSERT INTO users(name,email,password_hash,role,team) VALUES($1,$2,$3,'admin','general')
     ON CONFLICT (email) DO NOTHING`, [ADMIN_NAME || 'Admin', ADMIN_EMAIL.toLowerCase(), hash]);
  await pool.query(
    `INSERT INTO templates(name,language,body,category) VALUES
     ('followup_interest','en','Hi {{1}}, are you still interested? Reply here and we will continue.','utility')
     ON CONFLICT (name) DO NOTHING`);
  console.log('Seeded admin:', ADMIN_EMAIL);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
