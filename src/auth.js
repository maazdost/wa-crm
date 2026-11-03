const jwt = require('jsonwebtoken');
const { query } = require('./db');
const sign = (u) => jwt.sign({ id: u.id, role: u.role, name: u.name, v: u.session_version || 0 }, process.env.JWT_SECRET, { expiresIn: '30d' });

// A signed token alone is not enough: the person must still be active, and their sessions must not have been ended.
const cache = new Map(); // id -> { at, row }, kept for a few seconds so busy screens do not hit the database every time
async function current(id) {
  const c = cache.get(id); if (c && Date.now() - c.at < 10000) return c.row;
  const row = (await query('SELECT is_active, role, session_version FROM users WHERE id=$1', [id])).rows[0] || null;
  cache.set(id, { at: Date.now(), row }); return row;
}
const forget = (id) => cache.delete(Number(id));
const valid = (tok, cur) => !!cur && cur.is_active && (tok.v || 0) === cur.session_version;

function required(...roles) {
  return async (req, res, next) => {
    try {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      const tok = jwt.verify(token, process.env.JWT_SECRET), cur = await current(tok.id);
      if (!valid(tok, cur)) return res.status(401).json({ error: 'unauthorized' });
      req.user = { ...tok, role: cur.role };
      if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
      next();
    } catch { res.status(401).json({ error: 'unauthorized' }); }
  };
}
module.exports = { sign, required, current, forget, valid };
