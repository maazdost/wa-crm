const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
async function migrate() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  console.log('Database ready');
}
if (require.main === module) migrate().then(() => pool.end()).catch(e => { console.error(e); process.exit(1); });
module.exports = { migrate };
