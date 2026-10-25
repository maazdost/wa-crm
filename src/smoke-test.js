// End-to-end check against a running server (WA_DRY_RUN=true). Usage: npm run seed && npm start & npm test
const B = process.env.BASE || 'http://localhost:3000';
const j = async (path, opts = {}, token) => {
  const r = await fetch(B + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) }, body: opts.body && JSON.stringify(opts.body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const inbound = (from, msg) => fetch(B + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'WA ' + from } }], messages: [{ from, id: 'wamid.' + Math.random(), type: 'text', ...msg }] } }] }] }) });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fails++; };

(async () => {
  const admin = (await j('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'admin123' } })).data.token;
  const mk = async (n, team) => { const e = `${n}${Date.now()}@t.co`; await j('/api/users', { method: 'POST', body: { name: n, email: e, password: 'pw123456', team } }, admin);
    return (await j('/api/auth/login', { method: 'POST', body: { email: e, password: 'pw123456' } })).data; };
  const a1 = await mk('Ali', 'sales'), a2 = await mk('Sara', 'sales'), a3 = await mk('Omar', 'classes');

  const phones = ['9230010001', '9230010002', '9230010003', '9230010004'].map(p => p + Date.now().toString().slice(-4));
  // Each customer: greeting -> intent -> name -> handoff
  for (const [i, ph] of phones.entries()) {
    await inbound(ph, { text: { body: 'hi' } }); await sleep(150);
    await inbound(ph, { text: { body: i === 3 ? 'I want to join classes' : 'more info please' } }); await sleep(150);
    await inbound(ph, { text: { body: 'Customer' + i } }); await sleep(300);
  }
  const all = (await j('/api/conversations?status=open', {}, admin)).data;
  const mine = all.filter(c => phones.includes(c.wa_id));
  check('all 4 chats assigned after 3 bot steps', mine.length === 4 && mine.every(c => c.assigned_to));
  check('class intent routed to classes team agent', mine.find(c => c.wa_id === phones[3])?.assigned_to === a3.user.id);
  const salesAgents = mine.filter(c => c.wa_id !== phones[3]).map(c => c.assigned_to);
  check('sales chats spread across several sales agents', new Set(salesAgents).size >= 2);

  const l1 = (await j('/api/conversations', {}, a1.token)).data;
  check('agent sees only own chats', l1.length > 0 && l1.every(c => c.assigned_to === a1.user.id));
  const foreign = mine.find(c => c.assigned_to !== a1.user.id);
  check('agent blocked from other agent chat', (await j(`/api/conversations/${foreign.id}/messages`, {}, a1.token)).status === 403);

  const own = l1.find(c => phones.includes(c.wa_id));
  const sent = await j(`/api/conversations/${own.id}/messages`, { method: 'POST', body: { text: 'Hello from agent' } }, a1.token);
  check('agent can reply inside window', sent.status === 200);
  // Sticky: customer writes again, stays with same agent and bot stays silent
  await inbound(own.wa_id, { text: { body: 'one more question' } }); await sleep(300);
  const after = (await j(`/api/conversations/${own.id}/messages`, {}, a1.token)).data;
  check('sticky ownership kept', after.conversation.assigned_to === a1.user.id);
  check('bot silent after handoff', after.messages.filter(m => m.sender_type === 'bot').length === 3);
  // Window closed -> text rejected, template allowed
  await fetch; // no-op
  const { Pool } = require('pg'); require('dotenv').config();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`UPDATE conversations SET window_expires_at = now() - interval '1 hour' WHERE id=$1`, [own.id]);
  const blocked = await j(`/api/conversations/${own.id}/messages`, { method: 'POST', body: { text: 'late' } }, a1.token);
  check('free text blocked when window closed (409)', blocked.status === 409 && blocked.data.code === 'WINDOW_CLOSED');
  const tpl = await j(`/api/conversations/${own.id}/template`, { method: 'POST', body: { name: 'followup_interest' } }, a1.token);
  check('template send works when window closed', tpl.status === 200);
  check('manager stats endpoint', (await j('/api/stats', {}, admin)).data.totals?.open >= 4);
  check('agent cannot open admin endpoints', (await j('/api/users', {}, a1.token)).status === 403);
  await pool.end();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})();
