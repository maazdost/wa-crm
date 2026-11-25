// Payments page: payment screenshots waiting to be checked, Confirm (with a WhatsApp receipt) or Not received, and the totals.
// Managers and admins check payments; anyone can mark a photo in their own chat as a payment.
const express = require('express');
const { query } = require('../db');
const { required } = require('../auth');
const settings = require('../settings');
const payments = require('../payments');
const tenant = require('../tenant');
const C = () => tenant.cid();
const router = express.Router();
const mgr = required('admin', 'manager');
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });
const str = (x, n) => String(x == null ? '' : x).trim().slice(0, n);
const isDay = (d) => /^\d{4}-\d\d-\d\d$/.test(String(d || ''));

const LIST = `SELECT p.*, m.type AS media_type, m.body AS caption, m.media_name,
    COALESCE(NULLIF(ct.name,''), NULLIF(ct.profile_name,''), '+' || ct.wa_id) AS client, ct.wa_id, u.name AS agent, fu.name AS flagged_by_name, du.name AS decided_by_name, c.team
  FROM payments p JOIN contacts ct ON ct.id=p.contact_id LEFT JOIN messages m ON m.id=p.message_id LEFT JOIN conversations c ON c.id=p.conversation_id
  LEFT JOIN users u ON u.id=c.assigned_to LEFT JOIN users fu ON fu.id=p.flagged_by LEFT JOIN users du ON du.id=p.decided_by`;

router.get('/payments', mgr, wrap(async (req, res) => {
  const s = await settings.get('payments'), tz = s.tz || 'Asia/Karachi';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const from = isDay(req.query.from) ? req.query.from : today.slice(0, 8) + '01', to = isDay(req.query.to) ? req.query.to : today;
  const [pending, done, totals, byItem] = await Promise.all([
    query(`${LIST} WHERE p.company_id=$1 AND p.status='pending' ORDER BY p.created_at LIMIT 200`, [C()]),
    query(`${LIST} WHERE p.company_id=$1 AND p.status <> 'pending' AND p.status <> 'dismissed' AND (p.decided_at AT TIME ZONE $4)::date BETWEEN $2 AND $3 ORDER BY p.decided_at DESC LIMIT 2000`, [C(), from, to, tz]),
    query(`SELECT COALESCE(SUM(amount) FILTER (WHERE (decided_at AT TIME ZONE $2)::date = $3::date),0)::float AS today,
        COALESCE(SUM(amount) FILTER (WHERE date_trunc('month', decided_at AT TIME ZONE $2) = date_trunc('month', $3::date)),0)::float AS month,
        COUNT(*) FILTER (WHERE date_trunc('month', decided_at AT TIME ZONE $2) = date_trunc('month', $3::date))::int AS month_count,
        COALESCE(SUM(amount) FILTER (WHERE (decided_at AT TIME ZONE $2)::date BETWEEN $4 AND $5),0)::float AS range
      FROM payments WHERE company_id=$1 AND status='confirmed'`, [C(), tz, today, from, to]),
    query(`SELECT COALESCE(NULLIF(item,''),'Other') AS item, currency, COUNT(*)::int AS n, SUM(amount)::float AS total FROM payments
      WHERE company_id=$1 AND status='confirmed' AND (decided_at AT TIME ZONE $4)::date BETWEEN $2 AND $3 GROUP BY 1,2 ORDER BY total DESC`, [C(), from, to, tz])
  ]);
  const rcp = (p) => ({ ...p, receipt: p.receipt_no ? payments.receiptNo(s, p.receipt_no) : null });
  res.json({ settings: s, today, from, to, pending: pending.rows.map(rcp), done: done.rows.map(rcp), totals: totals.rows[0], byItem: byItem.rows });
}));

// Mark a photo or file a client sent as a payment to check (from the chat)
router.post('/messages/:id/payment', required(), wrap(async (req, res) => {
  const m = (await query(`SELECT m.id, m.direction, m.media_id, m.conversation_id, c.contact_id, c.assigned_to FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=$1 AND c.company_id=$2`, [Number(req.params.id) || 0, C()])).rows[0];
  if (!m) return res.status(404).json({ error: 'Message not found' });
  if (req.user.role === 'agent' && m.assigned_to !== req.user.id) return res.status(403).json({ error: 'This chat is not yours' });
  if (m.direction !== 'in' || !m.media_id) return res.status(400).json({ error: 'Only a photo or file from the client can be a payment' });
  const p = await payments.flag({ id: m.conversation_id, contact_id: m.contact_id }, m.id, req.user.id);
  res.json(p ? { payment: p } : { already: true });
}));

const load = async (req, res) => {
  const p = (await query('SELECT * FROM payments WHERE id=$1 AND company_id=$2', [Number(req.params.id) || 0, C()])).rows[0];
  if (!p) res.status(404).json({ error: 'Payment not found' });
  return p;
};
router.post('/payments/:id/confirm', mgr, wrap(async (req, res) => {
  const p = await load(req, res); if (!p) return;
  const b = req.body || {}, amount = Number(b.amount);
  if (!(amount > 0) || amount > 1e10) return res.status(400).json({ error: 'Enter the amount received' });
  let item = str(b.item, 120), product_id = Number(b.product_id) || null;
  if (product_id) { const pr = (await query('SELECT name FROM products WHERE id=$1 AND company_id=$2', [product_id, C()])).rows[0]; if (!pr) product_id = null; else if (!item) item = pr.name; }
  const out = await payments.confirm(p, { amount, currency: str(b.currency, 5).toUpperCase() || 'PKR', item, product_id, method: str(b.method, 40), note: str(b.note, 300), by: req.user.id });
  if (out.error) return res.status(409).json(out);
  res.json(out);
}));
router.post('/payments/:id/reject', mgr, wrap(async (req, res) => {
  const p = await load(req, res); if (!p) return;
  const out = await payments.reject(p, { notify: !!(req.body || {}).notify, by: req.user.id });
  if (out.error) return res.status(409).json(out);
  res.json(out);
}));
router.put('/payments-settings', mgr, wrap(async (req, res) => {
  const b = req.body || {}, cur = await settings.get('payments');
  const list = (x, n, len) => (Array.isArray(x) ? x : String(x || '').split(',')).map(w => str(w, len)).filter(Boolean).slice(0, n);
  const v = { ...cur, enabled: 'enabled' in b ? !!b.enabled : cur.enabled, prefix: (str(b.prefix ?? cur.prefix, 10).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'RCPT'),
    words: 'words' in b ? list(b.words, 40, 40).map(w => w.toLowerCase()) : cur.words, methods: 'methods' in b ? list(b.methods, 10, 30) : cur.methods,
    currency: /^[A-Z]{3}$/.test(String(b.currency || '')) ? b.currency : cur.currency };
  for (const f of ['receipt', 'not_received']) if (typeof b[f] === 'string' && b[f].trim()) v[f] = b[f].trim().slice(0, 1000);
  await settings.set('payments', v); res.json(v);
}));

module.exports = router;
