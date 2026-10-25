const jwt = require('jsonwebtoken');
const sign = (u) => jwt.sign({ id: u.id, role: u.role, name: u.name }, process.env.JWT_SECRET, { expiresIn: '30d' });
function required(...roles) {
  return (req, res, next) => {
    try {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      req.user = jwt.verify(token, process.env.JWT_SECRET);
      if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
      next();
    } catch { res.status(401).json({ error: 'unauthorized' }); }
  };
}
module.exports = { sign, required };
