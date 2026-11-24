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
  // Media Library and Quick Message (automatic keyword reply)
  const up = await fetch(B + '/api/media-library?filename=fees.png&mime=image/png', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + admin },
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') });
  const file = await up.json();
  check('manager saves a file in the media library', up.status === 200 && (await j('/api/media-library', {}, admin)).data.files?.some(f => f.id === file.id));
  check('agent cannot add library files', (await fetch(B + '/api/media-library?filename=x.png&mime=image/png', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + a1.token }, body: Buffer.from('x') })).status === 403);
  check('agent sends a library file in own chat', (await j(`/api/conversations/${own.id}/library/${file.id}`, { method: 'POST', body: { caption: 'Our fees' } }, a1.token)).status === 200);
  const rule = (await j('/api/auto-replies', { method: 'POST', body: { name: 'Fees', keywords: ['fee', 'fees'], match_type: 'contains', steps: [{ type: 'image', text: 'Our fee is 100 per month.', media_id: file.id }] } }, admin)).data;
  const botCount = async () => (await j(`/api/conversations/${own.id}/messages`, {}, a1.token)).data.messages.filter(m => m.sender_type === 'bot').length;
  const before = await botCount();
  await inbound(own.wa_id, { text: { body: 'I had a coffee' } }); await sleep(300);
  check('quick message ignores words that only look similar', await botCount() === before);
  await inbound(own.wa_id, { text: { body: 'What are your FEES?' } }); await sleep(500);
  const msgs = (await j(`/api/conversations/${own.id}/messages`, {}, a1.token)).data;
  check('quick message replies to its keyword with the saved file', msgs.messages.some(m => m.sender_type === 'bot' && m.body === 'Our fee is 100 per month.' && m.media_id) && msgs.conversation.assigned_to === a1.user.id);
  await j('/api/auto-replies/' + rule.id, { method: 'PATCH', body: { active: false } }, admin);
  await sleep(100); await inbound(own.wa_id, { text: { body: 'fees again' } }); await sleep(300);
  check('switched off quick message stays silent', await botCount() === before + 1);
  await j('/api/auto-replies/' + rule.id, { method: 'DELETE' }, admin);

  // Ad message: a new client's first message starts a sequence instead of the welcome bot, with a tag and a chosen agent
  const tagName = 'Scaling' + Date.now().toString().slice(-5);
  const tag = (await j('/api/labels', { method: 'POST', body: { name: tagName, color: '#0e5a4a' } }, admin)).data;
  const adText = 'Hi! I\'m interested in a Scaling Account. Please share more details.';
  const ad = (await j('/api/auto-replies', { method: 'POST', body: { name: 'Scaling ad', keywords: [adText], match_type: 'exact', tag_id: tag.id, assign_to: a2.user.id, steps: [
    { type: 'image', text: 'Welcome {{first_name}}!', media_id: file.id },
    { type: 'text', text: 'Join our community', buttons: [{ type: 'url', title: 'Community', url: 'https://example.com/join' }] },
    { type: 'text', text: 'Joined?', buttons: [{ type: 'reply', title: 'Yes Joined' }, { type: 'reply', title: 'No' }] }] } }, admin));
  const yes = (await j('/api/auto-replies', { method: 'POST', body: { name: 'Yes joined', keywords: ['Yes Joined'], match_type: 'exact', steps: [{ type: 'text', text: 'Thank you for connecting with us.' }] } }, admin)).data;
  const adPhone = '9230099' + Date.now().toString().slice(-6);
  await inbound(adPhone, { text: { body: adText } }); await sleep(700);
  const adConv = (await j('/api/conversations?status=open', {}, admin)).data.find(c => c.wa_id === adPhone);
  const adMsgs = adConv ? (await j(`/api/conversations/${adConv.id}/messages`, {}, admin)).data.messages.filter(m => m.sender_type === 'bot') : [];
  check('ad message starts the sequence in order, not the welcome bot', ad.status === 200 && adMsgs.length === 3 && adMsgs[0].body === 'Welcome WA!' && !!adMsgs[0].media_id && adMsgs[1].body.includes('https://example.com/join') && adMsgs[2].body.startsWith('Joined?'));
  check('ad chat gets the chosen agent and tag', !!adConv && adConv.assigned_to === a2.user.id && (adConv.labels || []).some(l => l.id === tag.id));
  await fetch(B + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: adPhone, profile: { name: 'WA ' + adPhone } }],
    messages: [{ from: adPhone, id: 'wamid.' + Math.random(), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'qm_0', title: 'Yes Joined' } } }] } }] }] }) }); await sleep(500);
  const adAfter = (await j(`/api/conversations/${adConv.id}/messages`, {}, admin)).data;
  check('button tap starts the next quick message and keeps the agent', adAfter.messages.some(m => m.body === 'Thank you for connecting with us.') && adAfter.conversation.assigned_to === a2.user.id);
  check('wrong rules are refused', (await j('/api/auto-replies', { method: 'POST', body: { name: 'Bad', keywords: ['x'], steps: [{ type: 'text', text: 'a', buttons: [{ type: 'url', title: 'A', url: 'https://a.co' }, { type: 'reply', title: 'B' }] }] } }, admin)).status === 400);
  await j('/api/auto-replies/' + ad.data.id, { method: 'DELETE' }, admin); await j('/api/auto-replies/' + yes.id, { method: 'DELETE' }, admin); await j('/api/labels/' + tag.id, { method: 'DELETE' }, admin);
  await j('/api/media-library/' + file.id, { method: 'DELETE' }, admin);

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
  const rep = await j('/api/reports', {}, admin);
  check('report gives totals, one row per day and agents', rep.status === 200 && rep.data.daily.length === 30 && rep.data.summary.inbound >= 12 && rep.data.agents.some(a => a.id === a1.user.id && a.msgs_sent >= 1) && rep.data.hours.length === 24);
  const today = rep.data.to, one = await j(`/api/reports?from=${today}&to=${today}`, {}, admin);
  check('report for one day and bad ranges', one.data.daily.length === 1 && one.data.daily[0].inbound >= 12 && (await j('/api/reports?from=2020-01-01&to=2026-01-01', {}, admin)).status === 400);
  const ha = await j('/api/health-audit', {}, admin);
  check('health audit returns a score and checks', ha.status === 200 && ha.data.score >= 0 && ha.data.score <= 100 && ha.data.checks.length >= 5 && ha.data.checks.every(c => c.level && c.title));
  check('agent cannot open reports or health audit', (await j('/api/reports', {}, a1.token)).status === 403 && (await j('/api/health-audit', {}, a1.token)).status === 403);
  check('agent cannot open admin endpoints', (await j('/api/users', {}, a1.token)).status === 403);
  await pool.end();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})();
