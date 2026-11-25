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
  await inbound(fp, { text: { body: 'hmm what' } }); await sleep(400);
  fs = await botSaid(fp);
  check('another answer than the buttons asks once more', fs.length === 3 && fs[2].includes('Please tap one of the buttons above.') && (await convOf(fp)).flow_step === 's2');
  await inbound(fp, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: `fl${fl.id}:s2:0`, title: 'Prices' } } }); await sleep(400);
  check('a button leads to its own step', (await botSaid(fp))[3] === 'Which city are you in?' && (await convOf(fp)).flow_step === 's3');
  await inbound(fp, { text: { body: 'Lahore' } }); await sleep(400);
  await inbound(fp, { text: { body: 'Bilal Ahmed' } }); await sleep(600);
  fs = await botSaid(fp); fc = await convOf(fp);
  const ftags = (await pool.query('SELECT label_id FROM conversation_labels WHERE conversation_id=$1', [fc.id])).rows.map(r => r.label_id);
  check('answers are kept, the name is saved and the chat is handed to the team', fs[4] === 'And your name?' && fs[5] === 'Thanks Bilal Ahmed, our team will write to you.' && fc.cname === 'Bilal Ahmed'
    && fc.flow_id === null && fc.status === 'open' && fc.assigned_to === a3.user.id && fc.team === 'classes' && ftags.includes(ftag.id));
  const fget = (await j('/api/flows', {}, admin)).data, frun = fget.runs.find(r => r.conversation_id === fc.id);
  check('the chatbot counts who started and who reached the end', fget.flows.find(f => f.id === fl.id).started_count === 1 && fget.flows.find(f => f.id === fl.id).finished_count === 1
    && frun && frun.result === 'done' && frun.answers.City === 'Lahore' && frun.answers.Name === 'Bilal Ahmed' && frun.answers['What do you need?'] === 'Prices' && frun.client === 'Bilal Ahmed');
  await inbound(fp, { text: { body: 'thank you' } }); await sleep(300);
  check('the chatbot is silent after the hand over', (await botSaid(fp)).length === 6);
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
  check('agent cannot open admin endpoints', (await j('/api/users', {}, a1.token)).status === 403);
  await pool.end();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})();
