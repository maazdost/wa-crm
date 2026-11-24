require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { query } = require('./db');
const { migrate } = require('./migrate');
const rt = require('./realtime');

const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=15552000' });
  next();
});
// The web app and the Android app are served by this same server, so cross-site access stays off unless you set CORS_ORIGIN.
if (process.env.CORS_ORIGIN) app.use(cors({ origin: process.env.CORS_ORIGIN }));
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) console.warn('WARNING: JWT_SECRET is missing or short. Set it to 40+ random characters.');
if (!process.env.WA_APP_SECRET) console.warn('WARNING: WA_APP_SECRET is not set, so webhook messages are not verified as coming from Meta.');
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));
// Each page of the app has its own address (/en/manage/reports); all of them open the same app file.
// The short form (/reports) still works and the app corrects the address.
const PAGES = ['dashboard', 'live-chat', 'contacts', 'templates', 'media-library', 'quick-replies', 'quick-message', 'broadcasts', 'catalogs', 'ad-manager', 'follow-ups', 'bot', 'reports', 'health-audit', 'agents', 'permissions', 'notifications', 'activity-log', 'tags', 'settings', 'companies'];
app.get(new RegExp(`^/(?:[a-z]{2}/[a-z-]+/)?(?:${PAGES.join('|')})/?$`), (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.use('/webhook', require('./routes/webhook'));
app.use('/api', require('./access').gate); // permissions and the activity log, in front of every route
app.use('/api', require('./routes/api'));
app.use('/api', require('./routes/marketing'));
app.use('/api', require('./routes/calls'));
app.use('/api', require('./routes/embedded'));
app.use('/api', require('./routes/library'));
app.use('/api', require('./routes/catalog'));
app.use('/api', require('./routes/reports'));
app.use('/api', require('./routes/manage'));

const server = http.createServer(app);
rt.init(server);

// Escalation: tell managers when a client has been waiting too long for their agent
const MIN = Number(process.env.ESCALATE_AFTER_MIN || 0);
if (MIN > 0) setInterval(async () => {
  try {
    const { rows } = await query(
      `UPDATE conversations SET escalated_at=now()
        WHERE status='open' AND unread_count>0 AND escalated_at IS NULL
          AND last_customer_message_at < now() - ($1 || ' minutes')::interval
          AND (last_agent_reply_at IS NULL OR last_agent_reply_at < last_customer_message_at)
        RETURNING id, assigned_to, company_id`, [String(MIN)]);
    rows.forEach(r => rt.toConversation({ company_id: r.company_id }, 'conversation:escalated', { conversationId: r.id, assignedTo: r.assigned_to }));
  } catch (e) { console.error('escalation', e.message); }
}, 60000);

const PORT = process.env.PORT || 3000;
migrate().then(require('./bootstrap')).then(() => require('./numbers').importFromEnv()).then(() => server.listen(PORT, () => { console.log(`WA CRM listening on ${PORT}`); require('./broadcast').start(); require('./drip').start(); }))
  .catch(e => { console.error(e); process.exit(1); });
module.exports = { app, server };
