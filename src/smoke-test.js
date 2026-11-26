// End-to-end check against a running server (WA_DRY_RUN=true, FLOW_SWEEP_MS=1000 SLOW_TICK_MS=1000 DEMO_TICK_MS=1000 so the timed checks are quick). Usage: npm run seed && npm start & npm test
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
  // Catalogs: products, sending them in a chat and from a quick message
  const prod = (await j('/api/products', { method: 'POST', body: { name: 'Gold Course', price: 15000, currency: 'PKR', description: 'Three months of classes.', link: 'https://example.com/gold', category: 'Courses', media_id: file.id } }, admin)).data;
  const plain = (await j('/api/products', { method: 'POST', body: { name: 'Free Webinar', in_stock: false } }, admin)).data;
  check('manager adds products and agents can see them', prod.id && prod.price === 15000 && plain.in_stock === false && (await j('/api/products', {}, a1.token)).data.products.length === 2);
  check('wrong products are refused and agents cannot change the catalog', (await j('/api/products', { method: 'POST', body: { name: '' } }, admin)).status === 400 && (await j('/api/products', { method: 'POST', body: { name: 'X', price: 'abc' } }, admin)).status === 400
    && (await j('/api/products', { method: 'POST', body: { name: 'X', link: 'not a link' } }, admin)).status === 400 && (await j('/api/products', { method: 'POST', body: { name: 'X' } }, a1.token)).status === 403 && (await j('/api/products/' + prod.id, { method: 'DELETE' }, a1.token)).status === 403);
  const ps = await j(`/api/conversations/${own.id}/products`, { method: 'POST', body: { ids: [prod.id, plain.id] } }, a1.token);
  check('agent sends products in own chat', ps.status === 200 && ps.data.messages.length === 2 && ps.data.messages[0].media_id && /^\*Gold Course\*\nPKR 15,000\n\nThree months of classes\.\n\nhttps:\/\/example\.com\/gold$/.test(ps.data.messages[0].body)
    && ps.data.messages[1].body === '*Free Webinar*\nOut of stock' && !ps.data.messages[1].media_id && (await j(`/api/conversations/${own.id}/products`, { method: 'POST', body: { ids: [prod.id] } }, a2.token)).status === 403);
  const prule = (await j('/api/auto-replies', { method: 'POST', body: { name: 'Catalog', keywords: ['show me the course'], match_type: 'exact', steps: [{ type: 'product', product_id: prod.id }, { type: 'text', text: 'Shall I book you in?' }] } }, admin)).data;
  await inbound(own.wa_id, { text: { body: 'Show me the course' } }); await sleep(600);
  const pm2 = (await j(`/api/conversations/${own.id}/messages`, {}, a1.token)).data.messages, pi = pm2.findIndex(m => m.sender_type === 'bot' && /^\*Gold Course\*/.test(m.body) && m.media_id);
  check('quick message sends a product, then the next message', prule.id && pi > 0 && pm2.slice(pi).some(m => m.body === 'Shall I book you in?')
    && (await j('/api/auto-replies', { method: 'POST', body: { name: 'Bad', keywords: ['y'], steps: [{ type: 'product', product_id: 999999 }] } }, admin)).status === 400
    && (await j('/api/products', {}, admin)).data.products.find(p => p.id === prod.id).sent_count === 2 && (await j('/api/products', {}, admin)).data.products.find(p => p.id === prod.id).used_in === 1);
  const sw = await j('/api/products/' + prod.id, { method: 'PATCH', body: { in_stock: false } }, admin);
  await j('/api/auto-replies/' + prule.id, { method: 'DELETE' }, admin); await j('/api/products/' + plain.id, { method: 'DELETE' }, admin); await j('/api/products/' + prod.id, { method: 'DELETE' }, admin);
  check('product stock switch and delete work', sw.data.in_stock === false && sw.data.name === 'Gold Course' && (await j('/api/products', {}, admin)).data.products.length === 0);
  await j('/api/media-library/' + file.id, { method: 'DELETE' }, admin);

  // Facebook and Instagram Automation: rules and the test run
  const fbr = (await j('/api/social/facebook/rules', { method: 'POST', body: { name: 'Price', trigger: 'comment', match_type: 'contains', keywords: ['price', 'Price', 'fee'], reply_text: 'Hi {{first_name}}, check your inbox.', private_text: 'Hello {{name}}, our fee is 100.' } }, admin)).data;
  const fba = (await j('/api/social/facebook/rules', { method: 'POST', body: { name: 'Thanks', trigger: 'comment', match_type: 'any', reply_text: 'Thank you!' } }, admin)).data;
  await j('/api/social/instagram/rules', { method: 'POST', body: { name: 'IG info', trigger: 'dm', match_type: 'exact', keywords: ['info'], reply_text: 'Here is the info.' } }, admin);
  const try1 = (await j('/api/social/facebook/test', { method: 'POST', body: { trigger: 'comment', text: 'What is the PRICE?', name: 'Ayesha Khan' } }, admin)).data;
  const try2 = (await j('/api/social/facebook/test', { method: 'POST', body: { trigger: 'comment', text: 'nice coffee', name: 'Bilal' } }, admin)).data;
  const try3 = (await j('/api/social/instagram/test', { method: 'POST', body: { trigger: 'dm', text: 'information' } }, admin)).data;
  const fbPage = (await j('/api/social/facebook', {}, admin)).data;
  check('social rules answer the right comment with the right reply', fbr.id && fbr.keywords.length === 2 && try1.matched && try1.rule.id === fbr.id && try1.reply === 'Hi Ayesha, check your inbox.' && try1.private_reply === 'Hello Ayesha Khan, our fee is 100.'
    && try2.matched && try2.rule.id === fba.id && try3.matched === false && fbPage.rules.length === 2 && fbPage.connected === false && fbPage.log.length === 2 && fbPage.log.every(l => l.status === 'test') && fbPage.rules.every(r => r.sent_count === 0));
  await j('/api/social/rules/' + fba.id, { method: 'PATCH', body: { active: false } }, admin);
  check('social rule switch, wrong rules and agents are handled', (await j('/api/social/facebook/test', { method: 'POST', body: { text: 'nice coffee' } }, admin)).data.matched === false
    && (await j('/api/social/facebook/rules', { method: 'POST', body: { name: 'Bad', match_type: 'contains', keywords: [], reply_text: 'x' } }, admin)).status === 400
    && (await j('/api/social/facebook/rules', { method: 'POST', body: { name: 'Bad', match_type: 'any' } }, admin)).status === 400 && (await j('/api/social/tiktok', {}, admin)).status === 404
    && (await j('/api/social/facebook', {}, a1.token)).status === 403 && (await j('/api/social/rules/' + fbr.id, { method: 'DELETE' }, a1.token)).status === 403);
  await j('/api/social/rules/' + fbr.id, { method: 'DELETE' }, admin); await j('/api/social/rules/' + fba.id, { method: 'DELETE' }, admin);
  check('social rules can be deleted and the log stays', (await j('/api/social/facebook', {}, admin)).data.rules.length === 0 && (await j('/api/social/facebook', {}, admin)).data.log.length === 2);

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
  // Permissions, Activity Log, Notification Preferences
  const st = (body) => j(`/api/conversations/${own.id}/status`, { method: 'POST', body }, a1.token);
  await j('/api/permissions', { method: 'PUT', body: { agent: { close: false }, manager: { reports: false } } }, admin);
  const refused = await st({ status: 'closed' });
  check('agent cannot close a chat when the admin switched it off', refused.status === 403 && /switched off/.test(refused.data.error) && (await j('/api/reports', {}, admin)).status === 200);
  const pm = await j('/api/permissions', { method: 'PUT', body: { agent: { close: true }, manager: { reports: true } } }, admin);
  check('permissions switch back on and only the admin can change them', pm.data.agent.find(x => x.key === 'close').on && (await st({ status: 'closed' })).status === 200 && (await st({ status: 'open' })).status === 200
    && (await j('/api/permissions', {}, a1.token)).status === 403 && (await j('/api/me', {}, a1.token)).data.perms.close === true);
  await sleep(300);
  const al = (await j('/api/activity-log?q=chat', {}, admin)).data, al2 = (await j('/api/activity-log', {}, admin)).data;
  check('activity log records who did what', al.rows.some(r => r.action === 'Closed a chat' && r.user_name === 'Ali' && r.detail) && al.rows.some(r => r.action === 'Reopened a chat')
    && al2.rows.some(r => r.action === 'Changed permissions' && /Agents: Close and reopen chats off/.test(r.detail)) && al2.rows.some(r => r.action === 'Added a team member') && al2.rows.some(r => r.action === 'Signed in')
    && !al2.rows.some(r => r.action === 'Closed a chat' && r.id > al.rows[0].id) && (await j('/api/activity-log', {}, a1.token)).status === 403);
  const np = await j('/api/me/notifications', { method: 'PUT', body: { message: false, quiet: { on: true, from: '23:00', to: '07:00' } } }, a1.token);
  const push = require('./push'), at = (h) => new Date(`2026-01-10T${h}:00+05:00`);
  check('notification preferences are saved per person', np.data.message === false && np.data.assigned === true && np.data.quiet.on && (await j('/api/me/notifications', {}, a2.token)).data.message === true
    && (await push.allowed(a1.user.id, 'message')) === false && push.quietNow({ on: true, from: '23:00', to: '07:00' }, at('23:30')) && push.quietNow({ on: true, from: '23:00', to: '07:00' }, at('06:59')) && !push.quietNow({ on: true, from: '23:00', to: '07:00' }, at('12:00')) && !push.quietNow({ on: false, from: '23:00', to: '07:00' }, at('23:30')));
  // Contacts: add, edit, tags, import with tags and email, filters, export, delete
  const cph = '9230030' + Date.now().toString().slice(-5), ctag = (await j('/api/labels', { method: 'POST', body: { name: 'VIP' + Date.now(), color: '#7c3aed' } }, admin)).data;
  const cadd = await j('/api/contacts', { method: 'POST', body: { name: 'Hand Added', phone: '+' + cph, email: 'hand@added.co', tags: [ctag.id] } }, admin);
  const cfind = async (q) => (await j('/api/contacts?q=' + encodeURIComponent(q), {}, admin)).data;
  let cone = (await cfind(cph)).rows[0];
  check('a contact can be added by hand with email and tag', cadd.status === 200 && cone && cone.name === 'Hand Added' && cone.email === 'hand@added.co' && cone.source === 'manual' && cone.tags.some(t => t.id === ctag.id)
    && (await j('/api/contacts', { method: 'POST', body: { name: 'Twice', phone: cph } }, admin)).status === 409 && (await j('/api/contacts', { method: 'POST', body: { name: 'Bad', phone: '12' } }, admin)).status === 400);
  await inbound(cph, { text: { body: 'hello there' } }); await sleep(400);
  await j('/api/contacts/' + cone.id, { method: 'PATCH', body: { name: 'Renamed Client', email: '', tags: [] } }, admin);
  await inbound(cph, { text: { body: 'second message' } }); await sleep(400);
  cone = (await cfind(cph)).rows[0];
  check('an edited name stays after the client writes again, and tags can be removed', cone.name === 'Renamed Client' && cone.email === null && cone.tags.length === 0 && cone.conversation_id && !!cone.last_seen
    && (await j('/api/contacts/' + cone.id, { method: 'PATCH', body: { email: 'not-an-email' } }, admin)).status === 400);
  const itag = 'Wati' + Date.now(), ibase = '92300400' + String(Date.now()).slice(-4), ip = (n) => ibase + n;
  const imp = (await j('/api/contacts/import', { method: 'POST', body: { list_name: 'Wati export', consent: true, rows: [{ name: 'Imp One', phone: ip(1), email: 'one@imp.co', tags: [itag, 'vip' + ctag.name.slice(3)] }, { name: 'Imp Two', phone: ip(2), tags: itag.toUpperCase() }, { name: 'Bad', phone: '123' }] } }, admin)).data;
  const byTag = (await j('/api/contacts?tag=' + ((await j('/api/labels', {}, admin)).data.find(l => l.name === itag) || {}).id, {}, admin)).data;
  const iOne = (await cfind(ip(1))).rows[0];
  check('import brings names, emails and tags, and creates missing tags once', imp.added === 2 && imp.skipped === 1 && imp.tags_created === 1 && byTag.found === 2 && iOne.email === 'one@imp.co' && iOne.source === 'import' && iOne.tags.some(t => t.id === ctag.id));
  const cexp = (await j('/api/contacts/export?list=' + encodeURIComponent('Wati export'), {}, admin)).data, clist = (await j('/api/contacts?source=import&opt=in&per=10', {}, admin)).data;
  check('filters, pages and export work', cexp.rows.length === 2 && clist.per === 10 && clist.rows.length <= 10 && clist.rows.every(c => c.source === 'import' && !c.opted_out) && clist.stats.total >= clist.found && clist.stats.imported >= 2 && (await j('/api/contacts', {}, a1.token)).status === 403);
  const cdel = await j('/api/contacts/' + cone.id, { method: 'DELETE' }, admin), cbulk = (await j('/api/contacts/delete', { method: 'POST', body: { ids: cexp.rows.map(c => c.id).concat(999999) } }, admin)).data;
  check('a contact is deleted with its chat, and several can be deleted at once', cdel.status === 200 && (await cfind(cph)).found === 0 && (await pool.query('SELECT 1 FROM conversations WHERE id=$1', [cone.conversation_id])).rows.length === 0 && cbulk.deleted === 2
    && (await j('/api/contacts/' + cone.id, { method: 'DELETE' }, admin)).status === 404);
  await j('/api/labels/' + ctag.id, { method: 'DELETE' }, admin); for (const l of (await j('/api/labels', {}, admin)).data.filter(l => l.name === itag)) await j('/api/labels/' + l.id, { method: 'DELETE' }, admin);
  // Chatbots: a flow with a message, buttons that branch, open questions, an action and the hand over
  const ftag = (await j('/api/labels', { method: 'POST', body: { name: 'Course lead' + Date.now(), color: '#128c7e' } }, admin)).data;
  const fsteps = [{ id: 's1', type: 'message', kind: 'text', text: 'Welcome {{first_name}}!', next: '' },
    { id: 's2', type: 'buttons', text: 'What do you need?', buttons: [{ title: 'Prices', next: 's3' }, { title: 'Talk to us', next: 's6' }] },
    { id: 's3', type: 'question', text: 'Which city are you in?', save: 'other', label: 'City', next: '' },
    { id: 's4', type: 'question', text: 'And your name?', save: 'name', next: '' },
    { id: 's5', type: 'action', tag_id: ftag.id, team: 'classes', next: '' },
    { id: 's6', type: 'handover', text: 'Thanks {{name}}, our team will write to you.' }];
  const fl = (await j('/api/flows', { method: 'POST', body: { name: 'Course bot', trigger: 'keyword', match_type: 'exact', keywords: ['start course'], steps: fsteps } }, admin)).data;
  const convOf = async (ph) => (await pool.query('SELECT c.*, ct.name AS cname FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.wa_id=$1', [ph])).rows[0];
  const botSaid = async (ph) => (await pool.query(`SELECT m.body FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN contacts ct ON ct.id=c.contact_id WHERE ct.wa_id=$1 AND m.sender_type='bot' ORDER BY m.id`, [ph])).rows.map(r => r.body);
  const fp = '9230020001' + Date.now().toString().slice(-4);
  check('a new chatbot is saved switched off', fl.id && fl.active === false && (await j('/api/flows', {}, a1.token)).status === 403);
  await j('/api/flows/' + fl.id, { method: 'PATCH', body: { active: true } }, admin);
  await inbound(fp, { text: { body: 'Start course' } }); await sleep(500);
  let fs = await botSaid(fp), fc = await convOf(fp);
  check('a keyword starts the chatbot, which sends up to its first question', fs.length === 2 && fs[0] === 'Welcome WA!' && fs[1].startsWith('What do you need?') && fc.flow_id === fl.id && fc.flow_step === 's2' && fc.status === 'bot');
  { // typing instead of tapping: words that fit one button choose it, anything else goes straight to a person
    const tp = '9230020002' + Date.now().toString().slice(-4), tq = '9230020003' + Date.now().toString().slice(-4);
    await inbound(tp, { text: { body: 'Start course' } }); await sleep(400);
    await inbound(tp, { text: { body: 'what are the prices?' } }); await sleep(400);
    check('typed words that fit a button choose that button', (await botSaid(tp))[2] === 'Which city are you in?' && (await convOf(tp)).flow_step === 's3');
    await inbound(tq, { text: { body: 'Start course' } }); await sleep(400);
    await inbound(tq, { text: { body: 'hmm what is this' } }); await sleep(500);
    const tc = await convOf(tq), trun = (await pool.query('SELECT result, answers FROM bot_flow_runs WHERE conversation_id=$1', [tc.id])).rows[0];
    check('anything else typed hands the chat to a person at once', (await botSaid(tq)).length === 2 && tc.flow_id === null && tc.status === 'open' && !!tc.assigned_to
      && trun.result === 'no_answer' && trun.answers['Typed instead'] === 'hmm what is this');
    // a client who does not answer: after FLOW_WAIT_MINUTES the chat goes to the team (the server checks every FLOW_SWEEP_MS)
    const wp = '9230020004' + Date.now().toString().slice(-4);
    await inbound(wp, { text: { body: 'Start course' } }); await sleep(400);
    const wc0 = await convOf(wp);
    const shown = (await j('/api/conversations?status=open', {}, admin)).data.some(c => c.id === wc0.id);
    await pool.query(`UPDATE bot_flow_runs SET updated_at = now() - interval '10 minutes' WHERE conversation_id=$1`, [wc0.id]);
    let wc = wc0; for (let k = 0; k < 40 && wc.flow_id; k++) { await sleep(500); wc = await convOf(wp); }
    check('managers see a client who is still with the chatbot, and one who does not answer goes to the team', shown && wc.flow_id === null && wc.status === 'open' && !!wc.assigned_to);
  }
  await inbound(fp, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: `fl${fl.id}:s2:0`, title: 'Prices' } } }); await sleep(400);
  check('a button leads to its own step', (await botSaid(fp))[2] === 'Which city are you in?' && (await convOf(fp)).flow_step === 's3');
  await inbound(fp, { text: { body: 'Lahore' } }); await sleep(400);
  await inbound(fp, { text: { body: 'Bilal Ahmed' } }); await sleep(600);
  fs = await botSaid(fp); fc = await convOf(fp);
  fs.splice(2, 0, ''); // (before, the bot asked once more here; the steps below keep their numbers)
  const ftags = (await pool.query('SELECT label_id FROM conversation_labels WHERE conversation_id=$1', [fc.id])).rows.map(r => r.label_id);
  check('answers are kept, the name is saved and the chat is handed to the team', fs[4] === 'And your name?' && fs[5] === 'Thanks Bilal Ahmed, our team will write to you.' && fc.cname === 'Bilal Ahmed'
    && fc.flow_id === null && fc.status === 'open' && fc.assigned_to === a3.user.id && fc.team === 'classes' && ftags.includes(ftag.id));
  const fget = (await j('/api/flows', {}, admin)).data, frun = fget.runs.find(r => r.conversation_id === fc.id);
  check('the chatbot counts who started and who reached the end', fget.flows.find(f => f.id === fl.id).started_count === 4 && fget.flows.find(f => f.id === fl.id).finished_count === 1
    && frun && frun.result === 'done' && frun.answers.City === 'Lahore' && frun.answers.Name === 'Bilal Ahmed' && frun.answers['What do you need?'] === 'Prices' && frun.client === 'Bilal Ahmed');
  await inbound(fp, { text: { body: 'thank you' } }); await sleep(300);
  check('the chatbot is silent after the hand over', (await botSaid(fp)).length === 5);
  // an agent who writes in the chat stops the chatbot
  await inbound(own.wa_id, { text: { body: 'start course' } }); await sleep(500);
  const mid = await convOf(own.wa_id);
  await j(`/api/conversations/${own.id}/messages`, { method: 'POST', body: { text: 'I will help you myself' } }, a1.token);
  const ownBot = (await botSaid(own.wa_id)).length;
  await inbound(own.wa_id, { text: { body: 'Prices' } }); await sleep(400);
  check('an agent who writes stops the chatbot', mid.flow_id === fl.id && mid.assigned_to === a1.user.id && (await convOf(own.wa_id)).flow_id === null && (await botSaid(own.wa_id)).length === ownBot);
  // the welcome chatbot takes the place of the built-in welcome bot only while it is switched on
  const wfile = await (await fetch(B + '/api/media-library?filename=brochure.png&mime=image/png', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + admin },
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') })).json();
  const wf = (await j('/api/flows', { method: 'POST', body: { name: 'Welcome', trigger: 'welcome', steps: [{ id: 'a', type: 'buttons', text: 'Hello! Are you a new client?', buttons: [{ title: 'Yes', next: 'b' }, { title: 'No', next: 'end' }] }, { id: 'b', type: 'message', kind: 'image', media_id: wfile.id, text: 'Our brochure', next: '' }] } }, admin)).data;
  const wp1 = '9230020002' + Date.now().toString().slice(-4), wp2 = '9230020003' + Date.now().toString().slice(-4);
  await inbound(wp1, { text: { body: 'hi' } }); await sleep(400);
  const greet = (await j('/api/settings', {}, admin)).data.bot.greet;
  check('a switched-off welcome chatbot changes nothing', (await botSaid(wp1))[0].startsWith(greet));
  await j('/api/flows/' + wf.id, { method: 'PATCH', body: { active: true } }, admin);
  await inbound(wp2, { text: { body: 'hi' } }); await sleep(400);
  await inbound(wp2, { text: { body: 'yes' } }); await sleep(600);
  const ws = await botSaid(wp2), wc = await convOf(wp2);
  check('a switched-on welcome chatbot greets new clients and sends its file', ws[0].startsWith('Hello! Are you a new client?') && ws[1] === 'Our brochure' && wc.status === 'open' && wc.bot_step === 'done' && wc.flow_id === null);
  const wf2 = (await j('/api/flows', { method: 'POST', body: { name: 'Welcome 2', trigger: 'welcome', steps: [{ id: 'a', type: 'message', kind: 'text', text: 'Hi', next: '' }] } }, admin)).data;
  await j('/api/flows/' + wf2.id, { method: 'PATCH', body: { active: true } }, admin);
  check('only one welcome chatbot is on at a time', (await j('/api/flows', {}, admin)).data.flows.filter(f => f.trigger === 'welcome' && f.active).map(f => f.id).join() === String(wf2.id));
  const bad = (steps, extra = {}) => j('/api/flows', { method: 'POST', body: { name: 'Bad', trigger: 'keyword', keywords: ['zz'], steps, ...extra } }, admin).then(r => r.status);
  check('wrong chatbots are refused', await bad([{ id: 'a', type: 'message', kind: 'text', text: 'x', next: 'nope' }]) === 400 && await bad([{ id: 'a', type: 'buttons', text: 'x', buttons: [] }]) === 400
    && await bad([{ id: 'a', type: 'message', kind: 'text', text: 'x' }, { id: 'a', type: 'message', kind: 'text', text: 'y' }]) === 400 && await bad([{ id: 'a', type: 'message', kind: 'text', text: 'x' }], { keywords: [] }) === 400
    && await bad([{ id: 'a', type: 'action' }]) === 400 && await bad([{ id: 'a', type: 'message', kind: 'product', product_id: 999999 }]) === 400);
  for (const f of [fl, wf, wf2]) await j('/api/flows/' + f.id, { method: 'DELETE' }, admin);
  const wp3 = '9230020004' + Date.now().toString().slice(-4);
  await inbound(wp3, { text: { body: 'hi' } }); await sleep(400);
  check('after deleting the chatbots the built-in welcome bot answers again', (await botSaid(wp3))[0].startsWith(greet) && (await j('/api/flows', {}, admin)).data.flows.length === 0);
  await j('/api/labels/' + ftag.id, { method: 'DELETE' }, admin); await j('/api/media-library/' + wfile.id, { method: 'DELETE' }, admin);
  // Custom fields, Audience, Pipeline and notifications for the installed app
  const u = Date.now().toString().slice(-6), fpost = (b) => j('/api/contacts/fields', { method: 'POST', body: b }, admin);
  const fCity = (await fpost({ name: 'City ' + u, kind: 'text', in_list: true })).data, fBud = (await fpost({ name: 'Budget ' + u, kind: 'number' })).data, fDob = (await fpost({ name: 'Birthday ' + u, kind: 'date' })).data,
    fLvl = (await fpost({ name: 'Level ' + u, kind: 'list', options: 'Beginner\nPro' })).data;
  check('custom fields are created, and wrong ones are refused', fCity.id && fCity.in_list === true && fBud.kind === 'number' && fLvl.options.length === 2 && (await fpost({ name: 'city ' + u })).status === 409 && (await fpost({ name: '' })).status === 400
    && (await fpost({ name: 'One choice ' + u, kind: 'list', options: ['A'] })).status === 400 && (await j('/api/contacts/fields', {}, a1.token)).status === 403 && (await j('/api/contacts/fields', {}, admin)).data.some(f => f.id === fDob.id));
  const fph = '9230050' + Date.now().toString().slice(-5), fct = (await j('/api/contacts', { method: 'POST', body: { name: 'Field Person', phone: fph, fields: { [fCity.id]: 'Lahore' + u, [fBud.id]: '1,500', [fDob.id]: '25/12/1990', [fLvl.id]: 'pro' } } }, admin)).data;
  let fone = (await cfind('Lahore' + u)).rows[0];
  check('a contact keeps its custom field answers and is found by them', fct.id && fone && fone.id === fct.id && fone.fields[fCity.id] === 'Lahore' + u && fone.fields[fBud.id] === '1500' && fone.fields[fDob.id] === '1990-12-25' && fone.fields[fLvl.id] === 'Pro'
    && (await j('/api/contacts/' + fct.id, { method: 'PATCH', body: { fields: { [fBud.id]: 'a lot' } } }, admin)).status === 400 && (await j('/api/contacts/' + fct.id, { method: 'PATCH', body: { fields: { [fCity.id]: '', [fBud.id]: '20' } } }, admin)).status === 200
    && (fone = (await cfind(fph)).rows[0]) && !(fCity.id in fone.fields) && fone.fields[fBud.id] === '20' && fone.fields[fLvl.id] === 'Pro');
  const fimp = (await j('/api/contacts/import', { method: 'POST', body: { list_name: 'Fields ' + u, consent: true, rows: [{ name: 'F Imp', phone: fph, fields: { [fCity.id]: 'Karachi', [fBud.id]: 'x', 999999: 'no' } }] } }, admin)).data;
  fone = (await cfind(fph)).rows[0];
  check('an import fills custom fields and keeps the other answers', fimp.updated === 1 && fone.fields[fCity.id] === 'Karachi' && fone.fields[fBud.id] === '20' && !('999999' in fone.fields));
  await j('/api/contacts/fields/' + fLvl.id, { method: 'PATCH', body: { name: 'Stage of learning ' + u, in_list: true } }, admin);
  check('a field is renamed and deleted, and deleting removes its answers', (await j('/api/contacts/fields', {}, admin)).data.find(f => f.id === fLvl.id).name === 'Stage of learning ' + u && (await j('/api/contacts/fields/' + fCity.id, { method: 'DELETE' }, admin)).status === 200
    && !(fCity.id in (await cfind(fph)).rows[0].fields) && (await j('/api/contacts/fields/' + fCity.id, { method: 'DELETE' }, admin)).status === 404);
  const pget = async (q = '') => (await j('/api/contacts/pipeline' + q, {}, admin)).data;
  let pl = await pget();
  check('the pipeline starts with four stages', pl.stages.length >= 4 && ['New Lead', 'Contacted', 'Interested', 'Follow-up'].every(n => pl.stages.some(s => s.name.toLowerCase().replace(/[^a-z]/g, '') === n.toLowerCase().replace(/[^a-z]/g, ''))) && pl.total > 0 && pl.unassigned.count > 0);
  const sNew = (await j('/api/contacts/pipeline/stages', { method: 'POST', body: { name: 'Won ' + u, color: '#10b981' } }, admin)).data, s0 = pl.stages[0];
  const mv = (from, to) => j('/api/contacts/pipeline/move', { method: 'POST', body: { contact_id: fct.id, from, to } }, admin);
  await mv(0, s0.id); pl = await pget('?q=' + fph);
  const in0 = pl.stages.find(s => s.id === s0.id), tagsOf = async () => (await cfind(fph)).rows[0].tags.map(t => t.id);
  check('a card moved into a stage gets the tag of that stage', sNew.id && in0.count === 1 && in0.cards[0].id === fct.id && pl.unassigned.count === 0 && (await tagsOf()).includes(s0.label_id)
    && (await j('/api/contacts/pipeline/stages', { method: 'POST', body: { name: 'won ' + u } }, admin)).status === 409);
  await mv(s0.id, sNew.id); pl = await pget('?q=' + fph);
  const wonTag = pl.stages.find(s => s.id === sNew.id).label_id;
  check('moving to another stage swaps the tag', pl.stages.find(s => s.id === s0.id).count === 0 && pl.stages.find(s => s.id === sNew.id).count === 1 && (await tagsOf()).includes(wonTag) && !(await tagsOf()).includes(s0.label_id)
    && (await j('/api/contacts/pipeline/cards?stage=' + sNew.id, {}, admin)).data.rows.some(c => c.id === fct.id) && (await mv(sNew.id, 999999)).status === 404 && (await j('/api/contacts/pipeline', {}, a1.token)).status === 403);
  const aud = (await j('/api/contacts/audience?q=' + fph, {}, admin)).data, audAll = (await j('/api/contacts/audience', {}, admin)).data;
  check('the audience groups people by tag', aud.groups.length === 1 && aud.groups[0].id === wonTag && aud.groups[0].people[0].id === fct.id && audAll.stats.total >= audAll.stats.untagged && audAll.stats.tags > 0 && audAll.groups.some(g => g.id === 0)
    && (await j('/api/contacts/audience/people?tag=' + wonTag, {}, admin)).data.rows.some(p => p.id === fct.id) && (await j('/api/contacts/audience', {}, a1.token)).status === 403);
  await j('/api/contacts/pipeline/stages/' + sNew.id, { method: 'PATCH', body: { name: 'Customer ' + u, move: -1 } }, admin); pl = await pget();
  const moved = pl.stages.findIndex(s => s.id === sNew.id);
  check('a stage is renamed, moved and removed, and the tag stays', pl.stages[moved].name === 'Customer ' + u && moved === pl.stages.length - 2 && (await j('/api/contacts/pipeline/stages/' + sNew.id, { method: 'DELETE' }, admin)).status === 200
    && !(await pget()).stages.some(s => s.id === sNew.id) && (await tagsOf()).includes(wonTag) && (await j('/api/labels', {}, admin)).data.some(l => l.id === wonTag && l.name === 'Customer ' + u));
  await j('/api/contacts/' + fct.id, { method: 'DELETE' }, admin); await j('/api/labels/' + wonTag, { method: 'DELETE' }, admin);
  for (const f of [fBud, fDob, fLvl]) await j('/api/contacts/fields/' + f.id, { method: 'DELETE' }, admin);
  // notifications for the installed app: the test catches what would be sent, nothing leaves this machine
  const pkey = (await j('/api/push/key', {}, a2.token)).data.key, ep = 'https://push.example.com/send/' + u, sent2 = [];
  const psub = await j('/api/push/subscribe', { method: 'POST', body: { endpoint: ep, keys: { p256dh: 'BKey' + u, auth: 'auth' + u } } }, a2.token);
  push.out.send = async (sub, payload) => { sent2.push({ sub, payload: JSON.parse(payload) }); };
  await push.notifyUser(a2.user.id, 'Client name', 'Hello', { conversationId: 7 }, 'message');
  await push.notifyUser(a1.user.id, 'Muted', 'Hello', {}, 'message'); // a1 switched message alerts off above
  const mine2 = sent2.filter(x => x.sub.endpoint === ep);
  push.out.send = async () => { const e = new Error('gone'); e.statusCode = 410; throw e; };
  await push.notifyUser(a2.user.id, 'Again', 'Hello', {}, 'message');
  check('the installed app gets notifications, respects each person\'s choices and forgets removed devices', typeof pkey === 'string' && pkey.length > 60 && psub.status === 200 && mine2.length === 1 && mine2[0].payload.title === 'Client name' && mine2[0].payload.conversationId === 7
    && mine2[0].sub.keys.auth === 'auth' + u && !sent2.some(x => x.payload.title === 'Muted') && (await pool.query('SELECT 1 FROM web_push_subs WHERE endpoint=$1', [ep])).rows.length === 0
    && (await j('/api/push/subscribe', { method: 'POST', body: { endpoint: 'http://not-secure', keys: {} } }, a2.token)).status === 400 && (await j('/api/push/key')).status === 401);

  // ---- AI Agent (the server runs with AI_FAKE=true in tests, so no request leaves it) ----
  const ai0 = (await j('/api/ai', {}, admin)).data;
  if (!ai0.ready) console.log('SKIP AI Agent checks: start the server with AI_FAKE=true to run them');
  else {
    const wasOn = (await pool.query(`UPDATE bot_flows SET active=FALSE WHERE trigger='welcome' AND active RETURNING id`)).rows.map(r => r.id); // a welcome chatbot would greet new clients first
    const NOTES = 'We are open 9am to 6pm, Monday to Saturday.\nThe course fee is Rs 5,000.';
    const aiSet = (b) => j('/api/ai', { method: 'PUT', body: { name: 'Sana', notes: NOTES, tone: 'friendly', language: 'auto', returning: true, max_replies: 10, ...b } }, admin);
    const lastLog = async (ph) => (await pool.query(`SELECT r.result FROM ai_replies r JOIN conversations c ON c.id=r.conversation_id JOIN contacts ct ON ct.id=c.contact_id WHERE ct.wa_id=$1 ORDER BY r.id DESC LIMIT 1`, [ph])).rows[0]?.result;
    check('the AI Agent cannot be switched on without notes, and agents cannot open its page', (await aiSet({ enabled: true, notes: 'hi' })).status === 400 && (await j('/api/ai', {}, a1.token)).status === 403 && ai0.settings.enabled === false);
    check('the AI Agent is saved and switched on', (await aiSet({ enabled: true })).status === 200 && (await j('/api/ai', {}, admin)).data.settings.name === 'Sana');
    const tr1 = await j('/api/ai/try', { method: 'POST', body: { notes: NOTES, turns: [{ role: 'user', text: 'When are you open?' }] } }, admin);
    check('Try it answers without sending anything', tr1.status === 200 && tr1.data.reply.includes('9am to 6pm') && tr1.data.handover === false);
    const u4 = Date.now().toString().slice(-4), q1 = '9230030001' + u4, q2 = '9230030002' + u4, q3 = '9230030003' + u4, q4 = '9230030004' + u4;
    await inbound(q1, { text: { body: 'What are your timings?' } }); await sleep(500);
    let said = await botSaid(q1), qc = await convOf(q1);
    const seen = (await j('/api/conversations?status=open', {}, admin)).data.some(c => c.wa_id === q1);
    check('the AI answers a new client from the notes and the chat stays with it', said.length === 1 && said[0].includes('9am to 6pm') && qc.status === 'bot' && qc.bot_step === 'ai' && !qc.assigned_to && seen && await lastLog(q1) === 'answered');
    await inbound(q1, { text: { body: 'I want to talk to a human' } }); await sleep(600);
    said = await botSaid(q1); qc = await convOf(q1);
    check('asking for a person hands the chat to an agent', said.length === 2 && /team member/.test(said[1]) && qc.bot_step === 'done' && qc.status === 'open' && !!qc.assigned_to && await lastLog(q1) === 'handover');
    await inbound(q1, { text: { body: 'hello again' } }); await sleep(400);
    check('after the hand over the AI stays quiet', (await botSaid(q1)).length === 2);
    // a closed chat that comes back: the AI answers first and the same agent keeps the chat
    const owner1 = qc.assigned_to;
    await j(`/api/conversations/${qc.id}/status`, { method: 'POST', body: { status: 'closed' } }, admin);
    await inbound(q1, { text: { body: 'What is the fee?' } }); await sleep(500);
    qc = await convOf(q1);
    const back = (await botSaid(q1)).length === 3 && qc.status === 'bot' && qc.bot_step === 'ai' && qc.assigned_to === owner1;
    await inbound(q1, { text: { body: 'agent please' } }); await sleep(600);
    qc = await convOf(q1);
    check('a returning client is answered by the AI first and goes back to the same agent', back && qc.status === 'open' && qc.bot_step === 'done' && qc.assigned_to === owner1);
    // a team member writes in a chat the AI is answering
    await inbound(q2, { text: { body: 'Do you have courses?' } }); await sleep(500);
    let c2 = await convOf(q2);
    const wrote = await j(`/api/conversations/${c2.id}/messages`, { method: 'POST', body: { text: 'Hi, I will help you from here.' } }, admin);
    await inbound(q2, { text: { body: 'ok thanks' } }); await sleep(400);
    c2 = await convOf(q2);
    check('when a team member writes, the AI steps back', wrote.status === 200 && c2.bot_step === 'done' && (await botSaid(q2)).length === 1);
    // a photo, a failure and the plan limit all end with an agent, never with silence
    await inbound(q3, { type: 'image', image: { id: 'media-ai-test', mime_type: 'image/jpeg' } }); await sleep(600);
    let c3 = await convOf(q3);
    check('a photo is handed to a person', c3.bot_step === 'done' && await lastLog(q3) === 'handover');
    await inbound(q4, { text: { body: 'fail-now' } }); await sleep(600);
    let c4 = await convOf(q4);
    check('when the AI fails the client still reaches the team', c4.bot_step === 'done' && (await botSaid(q4)).length === 0 && await lastLog(q4) === 'error');
    const q5 = '9230030005' + u4;
    await pool.query(`UPDATE companies SET limits = limits || '{"ai_replies":0}'::jsonb WHERE id=1`);
    await inbound(q5, { text: { body: 'What are your timings?' } }); await sleep(600);
    const c5 = await convOf(q5), lim = (await j('/api/ai', {}, admin)).data;
    await pool.query(`UPDATE companies SET limits = limits - 'ai_replies' WHERE id=1`);
    check('at the plan limit the AI stops and the chat goes to the team', c5.bot_step === 'done' && (await botSaid(q5)).length === 0 && await lastLog(q5) === 'limit' && lim.limit === 0 && lim.used >= 4);
    await aiSet({ enabled: false });
    const q6 = '9230030006' + u4;
    await inbound(q6, { text: { body: 'hi' } }); await sleep(400);
    check('switched off, new clients get the welcome bot as before', (await convOf(q6)).bot_step === 'ask_intent');
    if (wasOn.length) await pool.query('UPDATE bot_flows SET active=TRUE WHERE id = ANY($1::int[])', [wasOn]);
  }
  // Managers and admins can be put in the rotation: they get new chats, still see all chats, and have a "Mine" tab
  {
    const me = `rotmgr${Date.now()}@t.co`;
    const made = await j('/api/users', { method: 'POST', body: { name: 'Rota Manager', email: me, password: 'pw123456', role: 'manager', team: 'general' } }, admin);
    const mgr = (await j('/api/auth/login', { method: 'POST', body: { email: me, password: 'pw123456' } })).data;
    const startsOut = (await pool.query('SELECT in_rotation FROM users WHERE id=$1', [made.data.id])).rows[0].in_rotation === false;
    const before = (await pool.query(`SELECT id FROM users WHERE company_id=1 AND in_rotation AND id<>$1`, [made.data.id])).rows.map(r => r.id);
    await pool.query('UPDATE users SET in_rotation=false WHERE id = ANY($1::int[])', [before]);
    const on = await j(`/api/users/${made.data.id}`, { method: 'PATCH', body: { in_rotation: true } }, admin);
    const ph = '9230040001' + Date.now().toString().slice(-4);
    await inbound(ph, { text: { body: 'hi' } }); await sleep(200);
    await inbound(ph, { text: { body: 'more info please' } }); await sleep(200);
    await inbound(ph, { text: { body: 'Rota Client' } }); await sleep(400);
    const rc = await convOf(ph);
    check('a new manager starts out of the rotation, and once switched on gets new chats', startsOut && on.status === 200 && rc && rc.assigned_to === made.data.id);
    const mine = (await j('/api/conversations?status=open&view=mine', {}, mgr.token)).data, all = (await j('/api/conversations?status=open', {}, mgr.token)).data;
    const counts = (await j('/api/conversations/counts', {}, mgr.token)).data;
    check('the manager sees all chats, and only their own under Mine', mine.length === 1 && mine[0].id === rc.id && all.length > mine.length && counts.mine === 1);
    await j(`/api/users/${made.data.id}`, { method: 'PATCH', body: { in_rotation: false, is_active: false } }, admin);
    await pool.query('UPDATE users SET in_rotation=true WHERE id = ANY($1::int[])', [before]);
  }
  // A person can be in more than one department: rotation gives them chats of each department they are in
  {
    const em = `multi${Date.now()}@t.co`;
    const made = await j('/api/users', { method: 'POST', body: { name: 'Multi Dept', email: em, password: 'pw123456', team: 'general' } }, admin);
    const before = (await pool.query(`SELECT id FROM users WHERE company_id=1 AND in_rotation AND id<>$1`, [made.data.id])).rows.map(r => r.id);
    await pool.query('UPDATE users SET in_rotation=false WHERE id = ANY($1::int[])', [before]);
    const bad = await j(`/api/users/${made.data.id}`, { method: 'PATCH', body: { extra_teams: ['no-such-dept'] } }, admin);
    const set = await j(`/api/users/${made.data.id}`, { method: 'PATCH', body: { extra_teams: ['sales', 'general', 'sales'] } }, admin);
    const listed = (await j('/api/users', {}, admin)).data.find(u => u.id === made.data.id);
    const sales = (await j('/api/departments', {}, admin)).data.find(d => d.key === 'sales');
    check('extra departments are saved without the main one, unknown ones are refused', bad.status === 400 && set.status === 200 && JSON.stringify(listed.extra_teams) === '["sales"]' && sales.members >= 3);
    const ph = '9230050001' + Date.now().toString().slice(-4);
    await inbound(ph, { text: { body: 'hi' } }); await sleep(200);
    await inbound(ph, { text: { body: 'more info please' } }); await sleep(200);
    await inbound(ph, { text: { body: 'Multi Client' } }); await sleep(400);
    const mc = await convOf(ph);
    check('a chat of an extra department goes to that person by rotation', mc && mc.team === 'sales' && mc.assigned_to === made.data.id);
    await j(`/api/users/${made.data.id}`, { method: 'PATCH', body: { team: 'sales' } }, admin);
    const after = (await pool.query('SELECT team, extra_teams FROM users WHERE id=$1', [made.data.id])).rows[0];
    check('making an extra department the main one takes it off the extra list', after.team === 'sales' && after.extra_teams.length === 0);
    await j(`/api/users/${made.data.id}`, { method: 'PATCH', body: { in_rotation: false, is_active: false } }, admin);
    await pool.query('UPDATE users SET in_rotation=true WHERE id = ANY($1::int[])', [before]);
  }
  // A follow-up can be for one department only
  {
    const tn = 'fu_dept_' + Date.now().toString().slice(-6);
    await j('/api/templates', { method: 'POST', body: { name: tn, body: 'Hello {{1}}, any questions?', examples: ['Ali'] } }, admin);
    const step = [{ delay_hours: 24, template: tn, var_map: [{ type: 'name' }] }];
    const fc = await j('/api/drips', { method: 'POST', body: { name: 'Classes only', team: 'classes', steps: step } }, admin);
    const fs2 = await j('/api/drips', { method: 'POST', body: { name: 'Sales only', team: 'sales', steps: step } }, admin);
    const fbad = await j('/api/drips', { method: 'POST', body: { name: 'Bad', team: 'no-such-dept', steps: step } }, admin);
    const ph = '9230060001' + Date.now().toString().slice(-4);
    await inbound(ph, { text: { body: 'hi' } }); await sleep(200);
    await inbound(ph, { text: { body: 'I want to join classes' } }); await sleep(200);
    await inbound(ph, { text: { body: 'Dept Client' } }); await sleep(400);
    const got = (await pool.query('SELECT e.drip_id FROM drip_enrollments e JOIN contacts ct ON ct.id=e.contact_id WHERE ct.wa_id=$1', [ph])).rows.map(r => r.drip_id);
    const listed = (await j('/api/drips', {}, admin)).data.find(d => d.id === fc.data.id);
    check('a follow-up for one department only gets clients of that department', fc.status === 200 && fbad.status === 400 && listed.team === 'classes'
      && got.includes(fc.data.id) && !got.includes(fs2.data.id));
    for (const d of [fc.data, fs2.data]) await j('/api/drips/' + d.id, { method: 'DELETE' }, admin);
  }
  // Slow-reply alert: an agent who does not reply in time; managers are told and the chat moves once (server runs with SLOW_TICK_MS=1000)
  {
    const on = await j('/api/settings/assign', { method: 'PUT', body: { mode: 'least', batch: 1, slow_on: true, slow_min: 2 } }, admin);
    const sp = '9230070001' + Date.now().toString().slice(-4);
    await inbound(sp, { text: { body: 'hi' } }); await sleep(200);
    await inbound(sp, { text: { body: 'more info please' } }); await sleep(200);
    await inbound(sp, { text: { body: 'Slow Client' } }); await sleep(400);
    const s0 = await convOf(sp);
    const back = async () => { await pool.query(`UPDATE conversations SET assigned_at = now() - interval '3 minutes' WHERE id=$1`, [s0.id]);
      await pool.query(`UPDATE settings SET value = jsonb_set(value, '{slow_since}', to_jsonb((now() - interval '1 hour')::text)) WHERE company_id=1 AND key='assign'`); };
    await back();
    let s1 = s0; for (let k = 0; k < 20 && s1.assigned_to === s0.assigned_to; k++) { await sleep(500); s1 = await convOf(sp); }
    const log1 = (await pool.query('SELECT agent_id, moved_to FROM slow_replies WHERE conversation_id=$1', [s0.id])).rows;
    check('a slow agent: the chat moves once to another agent of the same department and it is logged', on.status === 200 && s0.team === 'sales' && s1.assigned_to && s1.assigned_to !== s0.assigned_to
      && [a1.user.id, a2.user.id].includes(s1.assigned_to) && log1.length === 1 && log1[0].agent_id === s0.assigned_to && log1[0].moved_to === s1.assigned_to);
    await back(); let n = 1; for (let k = 0; k < 20 && n < 2; k++) { await sleep(500); n = (await pool.query('SELECT COUNT(*)::int AS n FROM slow_replies WHERE conversation_id=$1', [s0.id])).rows[0].n; }
    const s2 = await convOf(sp), an = (await j('/api/analytics?days=7', {}, admin)).data;
    check('the second slow agent: the chat moves on again (to someone who has not had it, or round again), and the dashboard counts late replies', n === 2 && s2.assigned_to && s2.assigned_to !== s1.assigned_to && an.kpi.late >= 2);
    await j(`/api/conversations/${s0.id}/messages`, { method: 'POST', body: { text: 'Sorry for the wait!' } }, admin);
    await pool.query(`UPDATE conversations SET assigned_at = now() - interval '3 minutes' WHERE id=$1`, [s0.id]); await sleep(2500);
    check('once someone replies there is no alert', (await pool.query('SELECT COUNT(*)::int AS n FROM slow_replies WHERE conversation_id=$1', [s0.id])).rows[0].n === 2);
    await j('/api/settings/assign', { method: 'PUT', body: { mode: 'least', batch: 1, slow_on: false } }, admin);
  }
  // Ad routing: a client from an ad that a rule fits skips the welcome and goes straight to that department
  {
    const bad = await j('/api/ad-rules', { method: 'POST', body: { keywords: [], team: 'classes' } }, admin);
    const rule = await j('/api/ad-rules', { method: 'POST', body: { name: 'Classes ad', keywords: 'classes, course', team: 'classes', message: 'Hi {{first_name}}, here are our class details.' } }, admin);
    const ap = '9230080001' + Date.now().toString().slice(-4), np = '9230080002' + Date.now().toString().slice(-4);
    const adMsg = (h) => ({ text: { body: 'Hello! Can I get more info on this?' }, referral: { source_url: 'https://fb.me/abc', source_type: 'ad', source_id: '1201', headline: h } });
    await inbound(ap, adMsg('Join our Forex Classes today')); await sleep(600);
    await inbound(np, adMsg('Big sale on shoes')); await sleep(600);
    const ac = await convOf(ap), nc = await convOf(np), said = await botSaid(ap);
    const page = (await j('/api/ad-rules', {}, admin)).data, ad = page.ads.find(x => x.headline === 'Join our Forex Classes today');
    check('a client from a matching ad goes straight to that department with the ad message', bad.status === 400 && rule.status === 200 && ac.team === 'classes' && ac.assigned_to === a3.user.id
      && ac.status === 'open' && said.length === 1 && said[0] === 'Hi WA, here are our class details.' && ac.ad_rule_id === rule.data.id);
    check('an ad no rule fits gets the usual welcome, and the Ad Manager lists each ad with its rule', nc.ad_rule_id === null && nc.team !== 'classes'
      && ad && ad.leads === 1 && ad.rule_id === rule.data.id && page.rules.find(r => r.id === rule.data.id).hits === 1 && (await j('/api/ad-rules', {}, a1.token)).status === 403);
    await j('/api/ad-rules/' + rule.data.id, { method: 'DELETE' }, admin);
  }
  // Demo class bookings: the client books in the chat, the class fills up, a reminder goes out, and the team marks who came
  {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const set = await j('/api/demo-settings', { method: 'PUT', body: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], team: 'classes', words: 'demo, free class', morning: '00:00', before: 10,
      places: [{ key: 'office', name: 'Khushab office', time: '23:59', seats: 1, info: 'Main Road, Khushab' }, { key: 'online', name: 'Online', time: '23:58', seats: 0 }] } }, admin);
    const tap = (id) => ({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: id } } });
    const d1 = '9230090001' + Date.now().toString().slice(-4), d2 = '9230090002' + Date.now().toString().slice(-4);
    await inbound(d1, { text: { body: 'Can I join the demo class?' } }); await sleep(500);
    const asked = await botSaid(d1), c1 = await convOf(d1);
    await inbound(d1, tap('demo:p:office')); await sleep(400);
    await inbound(d1, tap(`demo:d:office:${today}`)); await sleep(500);
    const said1 = await botSaid(d1);
    const bk = (await pool.query(`SELECT * FROM demo_bookings WHERE conversation_id=$1`, [c1.id])).rows;
    const tagged = (await pool.query(`SELECT 1 FROM conversation_labels cl JOIN labels l ON l.id=cl.label_id WHERE cl.conversation_id=$1 AND l.name='Demo booked'`, [c1.id])).rows.length;
    check('a client asking for the demo gets place buttons, books a seat and is sent to Classes', set.status === 200 && asked.length === 1 && c1.team === 'classes' && c1.assigned_to === a3.user.id
      && said1.length >= 3 && said1.some(x => /^Your seat is booked, WA: Khushab office, \w{3} \d+ \w{3} at 11:59 PM/.test(x)) && bk.length === 1 && bk[0].status === 'booked' && tagged === 1);
    await inbound(d2, { text: { body: 'free class please' } }); await sleep(400);
    await inbound(d2, tap(`demo:d:office:${today}`)); await sleep(500);
    const said2 = await botSaid(d2), c2 = await convOf(d2);
    check('a full class is not booked and the client is offered the other places', said2.some(x => /full/.test(x)) && !(await pool.query(`SELECT 1 FROM demo_bookings WHERE conversation_id=$1`, [c2.id])).rows.length);
    await sleep(2500);
    const rb = (await pool.query(`SELECT * FROM demo_bookings WHERE id=$1`, [bk[0].id])).rows[0], said3 = await botSaid(d1);
    check('the reminder goes out once on the day of the class', !!rb.morning_at && said3.filter(x => /Good morning/.test(x)).length === 1);
    const page = (await j('/api/demo', {}, a3.token)).data;
    const deny = await j(`/api/demo/bookings/${bk[0].id}`, { method: 'PATCH', body: { status: 'came' } }, a1.token);
    const came = await j(`/api/demo/bookings/${bk[0].id}`, { method: 'PATCH', body: { status: 'came' } }, a3.token);
    const said4 = await botSaid(d1);
    check('the team sees the seat list and marking Came sends the join message', page.bookings.some(b => b.id === bk[0].id) && page.sessions.some(x => x.place === 'office' && x.day === today && x.booked === 1)
      && deny.status === 403 && came.status === 200 && came.data.sent && came.data.sent.sent && /join the full course/.test(said4[said4.length - 1]));
    const byAgent = await j('/api/demo/bookings', { method: 'POST', body: { conversation_id: c2.id, day: today, place: 'online' } }, admin);
    const bad = await j('/api/demo-settings', { method: 'PUT', body: { days: [] } }, admin);
    check('a manager can book a seat from the chat, and bad settings are refused', byAgent.status === 200 && byAgent.data.booking.place === 'online' && byAgent.data.sent && byAgent.data.sent.sent
      && bad.status === 400 && (await j('/api/demo-settings', { method: 'PUT', body: { enabled: false } }, a3.token)).status === 403);
    await j('/api/demo-settings', { method: 'PUT', body: { enabled: false } }, admin);
  }
  // Payments: a payment screenshot is caught, a manager confirms it, the client gets a numbered receipt
  {
    const pp = '9230070001' + Date.now().toString().slice(-4), q = '9230070002' + Date.now().toString().slice(-4);
    await inbound(pp, { text: { body: 'Hi, fees kitni hai?' } }); await sleep(400);
    await inbound(pp, { type: 'image', image: { id: 'payimg1' + Date.now(), mime_type: 'image/jpeg', caption: 'Payment bhej di JazzCash se' } }); await sleep(600);
    await inbound(q, { text: { body: 'hello' } }); await sleep(300);
    await inbound(q, { type: 'image', image: { id: 'payimg2' + Date.now(), mime_type: 'image/jpeg' } }); await sleep(600);
    const cp = await convOf(pp), cq = await convOf(q);
    const list = (await j('/api/payments', {}, admin)).data, pend = list.pending.find(x => x.conversation_id === cp.id);
    const tagged = (await pool.query(`SELECT 1 FROM conversation_labels cl JOIN labels l ON l.id=cl.label_id WHERE cl.conversation_id=$1 AND l.name='Payment to check'`, [cp.id])).rows.length;
    check('a photo sent with payment words waits on the Payments page and the chat is tagged', !!pend && pend.media_type === 'image' && tagged === 1 && !list.pending.some(x => x.conversation_id === cq.id));
    const qm = (await pool.query(`SELECT id FROM messages WHERE conversation_id=$1 AND media_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [cq.id])).rows[0];
    const mark = await j(`/api/messages/${qm.id}/payment`, { method: 'POST' }, admin), again = await j(`/api/messages/${qm.id}/payment`, { method: 'POST' }, admin);
    const agentNo = await j('/api/payments', {}, a1.token), agentConfirm = await j(`/api/payments/${pend.id}/confirm`, { method: 'POST', body: { amount: 15000 } }, a1.token);
    check('the team can mark any photo as a payment once, and agents cannot open or confirm payments', mark.status === 200 && !!mark.data.payment && again.data.already === true && agentNo.status === 403 && agentConfirm.status === 403);
    const bad = await j(`/api/payments/${pend.id}/confirm`, { method: 'POST', body: { amount: 0 } }, admin);
    const ok = await j(`/api/payments/${pend.id}/confirm`, { method: 'POST', body: { amount: 15000, item: 'Forex Classes', method: 'JazzCash' } }, admin);
    const twice = await j(`/api/payments/${pend.id}/confirm`, { method: 'POST', body: { amount: 15000 } }, admin);
    const said = await botSaid(pp), last = said[said.length - 1] || '';
    const labels = (await pool.query(`SELECT l.name FROM conversation_labels cl JOIN labels l ON l.id=cl.label_id WHERE cl.conversation_id=$1`, [cp.id])).rows.map(r => r.name);
    check('confirming sends a numbered receipt, tags the chat Enrolled and cannot happen twice', bad.status === 400 && ok.status === 200 && /^RCPT-\d{4}$/.test(ok.data.payment.receipt) && ok.data.sent.sent
      && last.includes(ok.data.payment.receipt) && last.includes('PKR 15,000') && last.includes('Forex Classes') && labels.includes('Enrolled') && !labels.includes('Payment to check') && twice.status === 409);
    const rej = await j(`/api/payments/${mark.data.payment.id}/reject`, { method: 'POST', body: { notify: true } }, admin), saidQ = await botSaid(q);
    const after = (await j('/api/payments', {}, admin)).data;
    check('not received sends a polite message, and totals and the per course list add up', rej.status === 200 && rej.data.sent.sent && /could not find this payment/.test(saidQ[saidQ.length - 1] || '')
      && after.totals.today >= 15000 && after.byItem.some(x => x.item === 'Forex Classes' && x.total >= 15000) && after.done.some(x => x.id === pend.id && x.receipt === ok.data.payment.receipt));
  }
  // Daily summary: one WhatsApp message with the day's numbers, as a message inside the 24 hour window or as the template outside it
  {
    const o1 = '9230060001' + Date.now().toString().slice(-4), o2 = '9230060002' + Date.now().toString().slice(-4);
    await inbound(o1, { text: { body: 'owner here' } }); await sleep(400);
    const bad = await j('/api/summary-settings', { method: 'PUT', body: { numbers: '12ab' } }, admin);
    const tpl = await j('/api/summary-settings/template', { method: 'POST' }, admin);
    const set = await j('/api/summary-settings', { method: 'PUT', body: { enabled: true, time: '00:00', numbers: `${o1}\n+${o2}` } }, admin);
    check('the daily summary settings are saved, a wrong number is refused, and switching on late waits for tomorrow', bad.status === 400 && tpl.status === 200 && tpl.data.template.name === 'daily_summary'
      && set.status === 200 && set.data.settings.numbers.join() === [o1, o2].join() && set.data.settings.last_day === set.data.today && /Daily summary/.test(set.data.preview)
      && (await j('/api/summary-settings', {}, a1.token)).status === 403);
    const now = await j('/api/summary-settings/send', { method: 'POST' }, admin), said = await botSaid(o1);
    const r1 = (now.data.results || []).find(x => x.to === o1), r2 = (now.data.results || []).find(x => x.to === o2);
    check('Send now: a number that wrote today gets the full message, another gets the template', now.status === 200 && r1 && r1.sent && r1.how === 'message' && r2 && r2.sent && r2.how === 'template'
      && /Daily summary/.test(said[said.length - 1] || '') && /New leads: \*\d+\*/.test(said[said.length - 1]) && /Payments confirmed/.test(said[said.length - 1]));
    await pool.query(`UPDATE settings SET value = value || '{"last_day":""}' WHERE key='summary'`); await sleep(2500);
    const after = (await botSaid(o1)).filter(x => /Daily summary/.test(x)).length; await sleep(1500);
    const later = (await botSaid(o1)).filter(x => /Daily summary/.test(x)).length;
    check('the nightly summary goes out once a day at the set time', after === 2 && later === 2);
    await j('/api/summary-settings', { method: 'PUT', body: { enabled: false } }, admin);
  }
  check('agent cannot open admin endpoints', (await j('/api/users', {}, a1.token)).status === 403);
  await pool.end();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})();
