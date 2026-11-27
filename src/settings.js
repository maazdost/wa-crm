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
  // slow_hours: the slow-reply alert and move only run between slow_start and slow_end (slow_tz); outside them it is off.
  assign: { mode: 'least', batch: 1, slow_on: false, slow_min: 10, slow_hours: true, slow_start: '10:00', slow_end: '22:00', slow_tz: 'Asia/Karachi' },
  routing: { info: 'sales', team: 'recruitment', classes: 'classes' }, // which department each bot button sends clients to
  gate: { mode: 'all', keywords: ['info', 'class', 'course', 'join', 'trading', 'price', 'fees', 'team', 'learn'] },
  // Demo class bookings (Demo Classes page). Days: 0 Sunday ... 6 Saturday. Times are in tz.
  demo: {
    enabled: false, tz: 'Asia/Karachi', days: [5, 6], team: '', words: ['demo class', 'free demo', 'free class', 'trial class'], // not just "demo": in trading it often means a demo account
    places: [{ key: 'office', name: 'At our office', time: '19:00', seats: 30, info: '' }, { key: 'online', name: 'Online', time: '20:30', seats: 100, info: '' }],
    morning: '10:00', before: 60, template: '',
    ask: 'Our free demo class: where would you like to join?',
    pick_day: 'Which day suits you for the {{place}} demo class?',
    booked: 'Your seat is booked, {{first_name}}: {{place}}, {{date}} at {{time}}. We will remind you before the class.',
    full: 'Sorry, that class is full now. Please choose another one.',
    none: 'There is no demo class open for booking right now. Our team will message you with the next date.',
    remind_morning: 'Good morning {{first_name}}! Your free demo class is today at {{time}} ({{place}}). See you there.',
    remind_hour: 'Your free demo class starts at {{time}} ({{place}}). {{info}}',
    came: 'Thank you for joining the demo class, {{first_name}}! Would you like to join the full course? Reply here and we will send you the fees and joining steps.',
    missed: 'We missed you at the demo class, {{first_name}}. Would you like to book the next one?'
  },
  // Payments page: payment screenshots to check, receipts. Words are looked for in the caption and the recent chat.
  payments: {
    enabled: true, prefix: 'RCPT', tz: 'Asia/Karachi', currency: 'PKR', methods: ['JazzCash', 'Easypaisa', 'Bank transfer', 'USDT', 'Cash'],
    words: ['paid', 'payment', 'transfer', 'jazzcash', 'jazz cash', 'easypaisa', 'easy paisa', 'receipt', 'screenshot', 'deposit', 'usdt', 'fee', 'fees', 'bhej di', 'bhej diye', 'kar di', 'kar diye', 'bheji'],
    receipt: '🧾 *Payment receipt {{receipt}}*\n{{company}}\n\nName: {{name}}\nFor: {{item}}\nAmount: {{amount}}\nMethod: {{method}}\nDate: {{date}}\n\nThank you, your payment is confirmed! ✅',
    not_received: 'Thank you {{first_name}}. We could not find this payment in our account yet. Please check the details and send the screenshot again, or tell us the time and the account you paid from.'
  },
  // Daily summary on WhatsApp (Settings > Daily summary). numbers: with country code. last_day: the day it was last sent (set by the app).
  summary: { enabled: false, time: '22:00', tz: 'Asia/Karachi', numbers: [], push: true, template: 'daily_summary', last_day: '' },
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
