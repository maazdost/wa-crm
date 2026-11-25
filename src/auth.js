const jwt = require('jsonwebtoken');
const { query } = require('./db');
const tenant = require('./tenant');
const sign = (u) => jwt.sign({ id: u.id, role: u.role, name: u.name, v: u.session_version || 0 }, process.env.JWT_SECRET, { expiresIn: '30d' });

// A signed token alone is not enough: the person must still be active, their sessions must not have been ended,
// and their company must not be paused. The company always comes from the database, never from the token.
const cache = new Map(); // id -> { at, row }, kept for a few seconds so busy screens do not hit the database every time
async function current(id) {
  const c = cache.get(id); if (c && Date.now() - c.at < 10000) return c.row;
  const row = (await query(
    `SELECT u.is_active, u.role, u.session_version, u.company_id, u.email, co.status AS company_status
       FROM users u JOIN companies co ON co.id=u.company_id WHERE u.id=$1`, [id])).rows[0] || null;
  cache.set(id, { at: Date.now(), row }); return row;
}
const forget = (id) => cache.delete(Number(id));
const forgetAll = () => cache.clear();
const valid = (tok, cur) => !!cur && cur.is_active && (tok.v || 0) === cur.session_version && (cur.company_status === 'active' || tenant.isSuper(cur.email));

function required(...roles) {
  return async (req, res, next) => {
    let tok, cur;
    try {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      tok = jwt.verify(token, process.env.JWT_SECRET); cur = await current(tok.id);
    } catch { return res.status(401).json({ error: 'unauthorized' }); }
    if (!valid(tok, cur)) return res.status(401).json({ error: cur && cur.company_status === 'paused' ? 'This company account is paused. Contact support.' : cur && cur.company_status === 'pending' ? 'Your account is waiting for approval. We will email you when it is ready.' : 'unauthorized' });
    req.user = { ...tok, role: cur.role, cid: cur.company_id, email: cur.email, is_super: tenant.isSuper(cur.email) };
    if (roles.includes('super') ? !req.user.is_super : (roles.length && !roles.includes(req.user.role))) return res.status(403).json({ error: 'forbidden' });
    tenant.run(cur.company_id, () => next()); // everything after this runs inside the person's company
  };
}
module.exports = { sign, required, current, forget, forgetAll, valid };
