const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const auth = require('./auth');
let io = null;

function init(httpServer) {
  io = new Server(httpServer, process.env.CORS_ORIGIN ? { cors: { origin: process.env.CORS_ORIGIN } } : {});
  io.use(async (socket, next) => {
    try {
      const tok = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET), cur = await auth.current(tok.id);
      if (!auth.valid(tok, cur)) throw new Error('ended');
      socket.user = { ...tok, role: cur.role, cid: cur.company_id };
      next();
    } catch { next(new Error('unauthorized')); }
  });
  io.on('connection', async (socket) => {
    const { id, role, cid } = socket.user;
    socket.join(`user:${id}`);
    if (role !== 'agent') socket.join(`managers:${cid}`); // managers only hear about their own company
    await require('./db').query('UPDATE users SET is_online=TRUE WHERE id=$1', [id]);
    socket.on('vis', v => { socket.data.vis = !!v; }); // the page says when it is on screen
    socket.on('disconnect', async () => {
      const left = await io.in(`user:${id}`).fetchSockets();
      if (!left.length) await require('./db').query('UPDATE users SET is_online=FALSE WHERE id=$1', [id]);
    });
  });
  return io;
}

// Send an event only to the owning agent and to the managers/admins of the same company.
function toConversation(conv, event, payload) {
  if (!io) return;
  if (conv.assigned_to) io.to(`user:${conv.assigned_to}`).emit(event, payload);
  const cid = conv.company_id || require('./tenant').maybe();
  if (cid) io.to(`managers:${cid}`).emit(event, payload);
  else console.warn('[realtime] no company for event', event);
}
const toUser = (userId, event, payload) => io && io.to(`user:${userId}`).emit(event, payload);

// True when this person has the app open and on screen right now.
async function watching(userId) {
  if (!io) return false;
  try { return (await io.in(`user:${userId}`).fetchSockets()).some(s => s.data && s.data.vis); } catch { return false; }
}
module.exports = { init, toConversation, toUser, watching };
