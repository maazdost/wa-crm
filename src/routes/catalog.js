// Catalogs: the product list of each company, and sending products into a chat.
const express = require('express');
const { query } = require('../db');
const { required } = require('../auth');
const { windowInfo } = require('../messages');
const mediaStore = require('../media');
const catalog = require('../catalog');
const tenant = require('../tenant');
const C = () => tenant.cid(); // the signed-in person's company; every query below is limited to it
const router = express.Router();
const mgr = required('admin', 'manager');
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });

const COLS = `p.id, p.name, p.price::float8 AS price, p.currency, p.description, p.link, p.category, p.in_stock, p.media_id, p.sent_count, p.created_at, p.updated_at,
  (SELECT COUNT(*)::int FROM auto_replies a WHERE a.company_id=p.company_id AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.steps) s WHERE s->>'product_id' = p.id::text)) AS used_in`;
const one = async (id) => (await query(`SELECT ${COLS} FROM products p WHERE p.id=$1 AND p.company_id=$2`, [id, C()])).rows[0];

// Checks a product sent from the page and returns it in the shape that is stored.
const clean = async (b) => {
  const str = (x, n) => String(x == null ? '' : x).trim().slice(0, n);
  const name = str(b.name, 80);
  if (!name) return { error: 'Give the product a name' };
  let price = null;
  if (b.price !== '' && b.price != null) {
    price = Number(b.price);
    if (!Number.isFinite(price) || price < 0 || price > 9999999999) return { error: 'The price must be a number, for example 1500' };
    price = Math.round(price * 100) / 100;
  }
  const link = str(b.link, 300);
  if (link && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(link)) return { error: 'The link must start with https://' };
  const media_id = Number(b.media_id) || null;
  if (media_id) {
    const f = (await query('SELECT mime FROM media_library WHERE id=$1 AND company_id=$2', [media_id, C()])).rows[0];
    if (!f) return { error: 'The chosen photo is no longer in the Media Library' };
    if (mediaStore.kindOf(f.mime) !== 'image') return { error: 'The product photo must be a JPG or PNG picture' };
  }
  return { name, price, currency: catalog.CURRENCIES.includes(b.currency) ? b.currency : 'PKR', description: str(b.description, 600), link, category: str(b.category, 40), in_stock: b.in_stock !== false, media_id };
};
const vals = (v) => [v.name, v.price, v.currency, v.description, v.link, v.category, v.in_stock, v.media_id];

// Everyone in the company can see the products, because agents send them in chats.
router.get('/products', required(), wrap(async (req, res) => {
  const products = (await query(`SELECT ${COLS} FROM products p WHERE p.company_id=$1 ORDER BY p.id DESC`, [C()])).rows;
  res.json({ products, currencies: catalog.CURRENCIES });
}));
router.post('/products', mgr, wrap(async (req, res) => {
  const v = await clean(req.body); if (v.error) return res.status(400).json(v);
  const n = (await query('SELECT COUNT(*)::int AS n FROM products WHERE company_id=$1', [C()])).rows[0].n;
  if (n >= 500) return res.status(400).json({ error: 'A catalog can hold up to 500 products. Delete the ones you no longer sell.' });
  const r = (await query('INSERT INTO products(company_id,name,price,currency,description,link,category,in_stock,media_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id', [C(), ...vals(v), req.user.id])).rows[0];
  res.json(await one(r.id));
}));
router.patch('/products/:id', mgr, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (Object.keys(req.body).length === 1 && 'in_stock' in req.body) { // the in stock switch
    const r = (await query('UPDATE products SET in_stock=$3, updated_at=now() WHERE id=$1 AND company_id=$2 RETURNING id', [id, C(), !!req.body.in_stock])).rows[0];
    return r ? res.json(await one(id)) : res.status(404).json({ error: 'not found' });
  }
  const v = await clean(req.body); if (v.error) return res.status(400).json(v);
  const r = (await query('UPDATE products SET name=$3, price=$4, currency=$5, description=$6, link=$7, category=$8, in_stock=$9, media_id=$10, updated_at=now() WHERE id=$1 AND company_id=$2 RETURNING id', [id, C(), ...vals(v)])).rows[0];
  r ? res.json(await one(id)) : res.status(404).json({ error: 'not found' });
}));
router.delete('/products/:id', mgr, wrap(async (req, res) => {
  await query('DELETE FROM products WHERE id=$1 AND company_id=$2', [Number(req.params.id) || 0, C()]);
  res.json({ ok: true });
}));

// Send up to 5 products into a chat (any agent, in their own chats; same 24h rule as other messages)
router.post('/conversations/:id/products', required(), wrap(async (req, res) => {
  const c = (await query('SELECT c.*, ct.wa_id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=$1 AND c.company_id=$2', [Number(req.params.id) || 0, C()])).rows[0];
  if (!c) return res.status(404).json({ error: 'not found' });
  if (req.user.role === 'agent' && c.assigned_to !== req.user.id) return res.status(403).json({ error: 'not your conversation' });
  if (!windowInfo(c).window_open) return res.status(409).json({ error: 'The reply window is closed. Send an approved template first.', code: 'WINDOW_CLOSED' });
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean))].slice(0, 5);
  if (!ids.length) return res.status(400).json({ error: 'Choose at least one product' });
  const rows = (await query('SELECT * FROM products WHERE company_id=$1 AND id = ANY($2::int[])', [C(), ids])).rows;
  if (!rows.length) return res.status(404).json({ error: 'These products are no longer in the catalog' });
  const messages = [];
  try {
    for (const id of ids) { const p = rows.find(x => x.id === id); if (p) messages.push(await catalog.send(c, c.wa_id, p, { senderType: 'agent', senderId: req.user.id })); }
    await query('UPDATE conversations SET unread_count=0, escalated_at=NULL WHERE id=$1', [c.id]);
    res.json({ messages });
  } catch (e) { res.status(502).json({ error: e.message, messages }); }
}));

module.exports = router;
