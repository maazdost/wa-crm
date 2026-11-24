const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { migrate } = require('./migrate');
// Local testing only: makes sure the admin login of company 1 exists.
(async () => {
  await migrate();
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  await pool.query(
    `INSERT INTO users(company_id,name,email,password_hash,role,team) VALUES(1,$1,$2,$3,'admin','general')
     ON CONFLICT (email) DO NOTHING`, [ADMIN_NAME || 'Admin', ADMIN_EMAIL.toLowerCase(), hash]);
  await pool.query(
    `INSERT INTO templates(company_id,name,language,body,category) VALUES
     (1,'followup_interest','en','Hi {{1}}, are you still interested? Reply here and we will continue.','utility')
     ON CONFLICT (company_id,name) DO NOTHING`);
  console.log('Seeded admin:', ADMIN_EMAIL);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
