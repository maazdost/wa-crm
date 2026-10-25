const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
let io = null;

function init(httpServer) {
  io = new Server(httpServer, { cors: { origin: process.env.CORS_ORIGIN || '*' } });
  io.use((socket, next) => {
    try {
      socket.user = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET);
      next();
    } catch { next(new Error('unauthorized')); }
  });
  io.on('connection', async (socket) => {
    const { id, role } = socket.user;
    socket.join(`user:${id}`);
    if (role !== 'agent') socket.join('managers');
    await require('./db').query('UPDATE users SET is_online=TRUE WHERE id=$1', [id]);
    socket.on('disconnect', async () => {
      const left = await io.in(`user:${id}`).fetchSockets();
      if (!left.length) await require('./db').query('UPDATE users SET is_online=FALSE WHERE id=$1', [id]);
    });
  });
  return io;
}

// Send an event only to the owning agent and to managers/admins.
function toConversation(conv, event, payload) {
  if (!io) return;
  if (conv.assigned_to) io.to(`user:${conv.assigned_to}`).emit(event, payload);
  io.to('managers').emit(event, payload);
}
const toUser = (userId, event, payload) => io && io.to(`user:${userId}`).emit(event, payload);

module.exports = { init, toConversation, toUser };
