const { query } = require('./db');
const DEFAULTS = {
  bot: {
    greet: 'Assalam o Alaikum! Welcome to our trading academy. How can we help you today?',
    askName: 'Great choice! May I know your name please?',
    handoff: 'Thank you {{name}}! One of our advisors will message you shortly to guide you personally.',
    btnInfo: 'More info', btnTeam: 'Join our team', btnClasses: 'Join classes'
  },
  wa: { waba_id: '' },
  gate: { mode: 'all', keywords: ['info', 'class', 'course', 'join', 'trading', 'price', 'fees', 'team', 'learn'] },
  away: {
    enabled: false, message: 'Thanks for your message! Our team is offline right now and will reply as soon as we are back.',
    start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5, 6], tz: 'Asia/Karachi'
  }
};
async function get(key) {
  const r = (await query('SELECT value FROM settings WHERE key=$1', [key])).rows[0];
  return { ...DEFAULTS[key], ...(r ? r.value : {}) };
}
const set = (key, value) => query(`INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, value]);
module.exports = { get, set };
