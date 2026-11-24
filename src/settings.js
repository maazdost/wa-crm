const { query } = require('./db');
const tenant = require('./tenant');
const DEFAULTS = {
  bot: {
    greet: 'Assalam o Alaikum! Welcome to our trading academy. How can we help you today?',
    askName: 'Great choice! May I know your name please?',
    handoff: 'Thank you {{name}}! One of our advisors will message you shortly to guide you personally.',
    btnInfo: 'More info', btnTeam: 'Join our team', btnClasses: 'Join classes'
  },
  wa: { waba_id: '' },
  assign: { mode: 'least', batch: 1 },
  routing: { info: 'sales', team: 'recruitment', classes: 'classes' }, // which department each bot button sends clients to
  gate: { mode: 'all', keywords: ['info', 'class', 'course', 'join', 'trading', 'price', 'fees', 'team', 'learn'] },
  away: {
    enabled: false, message: 'Thanks for your message! Our team is offline right now and will reply as soon as we are back.',
    start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5, 6], tz: 'Asia/Karachi'
  }
};
// Settings belong to the company of the current request or job.
async function get(key) {
  const r = (await query('SELECT value FROM settings WHERE company_id=$1 AND key=$2', [tenant.cid(), key])).rows[0];
  return { ...DEFAULTS[key], ...(r ? r.value : {}) };
}
const set = (key, value) => query(`INSERT INTO settings(company_id,key,value) VALUES($1,$2,$3) ON CONFLICT (company_id,key) DO UPDATE SET value=EXCLUDED.value`, [tenant.cid(), key, value]);
module.exports = { get, set };
