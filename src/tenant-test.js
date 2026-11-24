// Checks that companies never see each other's data. Run against a local server started with
// WA_DRY_RUN=true SIGNUP_ENABLED=true SUPER_ADMIN_EMAILS=admin@example.com  (after npm run seed).  Usage: npm run test:tenants
const B = process.env.BASE || 'http://localhost:3000';
const j = async (path, opts = {}, token) => {
  const r = await fetch(B + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) }, body: opts.body && JSON.stringify(opts.body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const inbound = (from, body, pid) => fetch(B + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ entry: [{ changes: [{ value: { ...(pid && { metadata: { phone_number_id: pid } }), contacts: [{ wa_id: from, profile: { name: 'WA ' + from } }], messages: [{ from, id: 'wamid.' + Math.random(), type: 'text', text: { body } }] } }] }] }) });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fails++; };

(async () => {
  const tag = Date.now().toString().slice(-6);
  const A = (await j('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'admin123' } })).data;
  check('company 1 admin signs in', !!A.token);

  // A new company signs up
  const su = await j('/api/auth/signup', { method: 'POST', body: { company: 'Beta ' + tag, name: 'Bea', email: `bea${tag}@beta.co`, password: 'pw123456' } });
  check('sign-up creates company and admin', su.status === 200 && !!su.data.token && su.data.user.role === 'admin');
  const Bt = su.data.token;
  check('sign-up refuses a used email', (await j('/api/auth/signup', { method: 'POST', body: { company: 'X', name: 'X', email: `bea${tag}@beta.co`, password: 'pw123456' } })).status === 409);
  check('new company starts empty', (await j('/api/conversations', {}, Bt)).data.length === 0 && (await j('/api/users', {}, Bt)).data.length === 1);
  check('new company has its own departments', (await j('/api/departments', {}, Bt)).data.map(d => d.key).sort().join() === 'general,sales,support');
  check('new company has neutral bot wording', /Beta/.test((await j('/api/settings', {}, Bt)).data.bot.greet));

  // Company B adds its own WhatsApp number; messages to that number belong to B
  const pid = '9' + tag + '0001';
  const add = await j('/api/whatsapp/numbers', { method: 'POST', body: { label: 'Beta main', phone_number_id: pid, access_token: 'x' } }, Bt);
  check('company 2 adds its number', add.status === 200 && add.data.is_default === true);
  const sharedPhone = '92300' + tag + '9';
  await inbound(sharedPhone, 'hello beta', pid); await sleep(400);
  await inbound(sharedPhone, 'hello main company'); await sleep(400); // same person also writes to company 1's number

  const bConvs = (await j('/api/conversations?status=bot', {}, Bt)).data;
  check('company 2 sees the chat sent to its number', bConvs.length === 1 && bConvs[0].wa_id === sharedPhone);
  const aConvs = (await j('/api/conversations?status=bot', {}, A.token)).data;
  const aMine = aConvs.find(c => c.wa_id === sharedPhone);
  check('company 1 has its own separate chat with the same person', !!aMine && aMine.id !== bConvs[0].id);
  const bMsgs = (await j(`/api/conversations/${bConvs[0].id}/messages`, {}, Bt)).data.messages || [];
  check('company 2 chat holds only its own messages', bMsgs.some(m => m.body === 'hello beta') && !bMsgs.some(m => m.body === 'hello main company'));
  check('company 2 bot uses its own greeting', bMsgs.some(m => m.sender_type === 'bot' && /Beta/.test(m.body)));

  // Nothing of company 1 reaches company 2, and the other way round
  check('company 2 cannot open a company 1 chat', (await j(`/api/conversations/${aMine.id}/messages`, {}, Bt)).status === 404);
  check('company 1 cannot open a company 2 chat', (await j(`/api/conversations/${bConvs[0].id}/messages`, {}, A.token)).status === 404);
  check('company 2 cannot write in a company 1 chat', (await j(`/api/conversations/${aMine.id}/notes`, { method: 'POST', body: { body: 'x' } }, Bt)).status === 404);
  const aUsers = (await j('/api/users', {}, A.token)).data, bUsers = (await j('/api/users', {}, Bt)).data;
  check('team lists are separate', !aUsers.some(u => u.email.startsWith('bea')) && bUsers.every(u => u.email.startsWith('bea')));
  check('company 2 cannot change a company 1 person', (await j('/api/users/' + aUsers[0].id, { method: 'PATCH', body: { name: 'hacked' } }, Bt)).status === 404);
  check('company 2 cannot assign its chat to a company 1 agent', (await j(`/api/conversations/${bConvs[0].id}/reassign`, { method: 'POST', body: { agent_id: aUsers[0].id } }, Bt)).status === 400);
  const aNums = (await j('/api/whatsapp/numbers', {}, A.token)).data, bNums = (await j('/api/whatsapp/numbers', {}, Bt)).data;
  check('WhatsApp numbers are separate', !aNums.some(n => n.phone_number_id === pid) && bNums.length === 1);
  check('company 2 cannot change a company 1 number', !aNums[0] || (await j('/api/whatsapp/numbers/' + aNums[0].id, { method: 'PATCH', body: { label: 'x' } }, Bt)).status === 404);
  check('contacts are separate', (await j('/api/contacts', {}, Bt)).data.total === 1);
  check('templates are separate', (await j('/api/templates', {}, Bt)).data.length === 0);
  check('dashboard counts only own chats', (await j('/api/analytics', {}, Bt)).data.kpi.with_bot === 1);
  check('stats count only own chats', (await j('/api/stats', {}, Bt)).data.totals.with_bot === 1);
  await j('/api/labels', { method: 'POST', body: { name: 'BetaOnly' } }, Bt);
  check('labels are separate', !(await j('/api/labels', {}, A.token)).data.some(l => l.name === 'BetaOnly'));
  await j('/api/quick-replies', { method: 'POST', body: { shortcut: 'hi', title: 'Hi', body: 'Beta hi' } }, Bt);
  check('same quick-reply shortcut allowed in two companies', (await j('/api/quick-replies', {}, Bt)).data.some(q => q.body === 'Beta hi') && !(await j('/api/quick-replies', {}, A.token)).data.some(q => q.body === 'Beta hi'));
  await j('/api/settings/bot', { method: 'PUT', body: { greet: 'Beta changed greeting' } }, Bt);
  check('settings are separate', (await j('/api/settings', {}, A.token)).data.bot.greet !== 'Beta changed greeting');

  // Permissions and the Activity Log stay inside each company
  await j('/api/permissions', { method: 'PUT', body: { manager: { reports: false } } }, A.token);
  const bLog = (await j('/api/activity-log', {}, Bt)).data.rows;
  check('other company keeps its own permissions and activity log', (await j('/api/permissions', {}, Bt)).data.manager.find(x => x.key === 'reports').on === true
    && bLog.length > 0 && bLog.every(r => r.user_name === 'Bea') && !bLog.some(r => r.action === 'Changed permissions'));
  await j('/api/permissions', { method: 'PUT', body: { manager: { reports: true } } }, A.token);
  // Facebook and Instagram rules stay inside each company
  const sr = (await j('/api/social/facebook/rules', { method: 'POST', body: { name: 'A social', match_type: 'any', reply_text: 'Hi from A' } }, A.token)).data;
  check('social rules are separate', sr.id && (await j('/api/social/facebook', {}, Bt)).data.rules.length === 0 && (await j('/api/social/facebook/test', { method: 'POST', body: { text: 'hello' } }, Bt)).data.matched === false
    && (await j('/api/social/rules/' + sr.id, { method: 'PATCH', body: { active: false } }, Bt)).status === 404 && (await j('/api/social/facebook', {}, Bt)).data.log.length === 0);
  await j('/api/social/rules/' + sr.id, { method: 'DELETE' }, Bt);
  check('other company cannot delete a social rule', (await j('/api/social/facebook', {}, A.token)).data.rules.some(r => r.id === sr.id));
  await j('/api/social/rules/' + sr.id, { method: 'DELETE' }, A.token);
  // Catalogs stay inside each company
  const pa = (await j('/api/products', { method: 'POST', body: { name: 'A product', price: 10 } }, A.token)).data;
  check('products are separate', pa.id && !(await j('/api/products', {}, Bt)).data.products.some(p => p.id === pa.id) && (await j('/api/products/' + pa.id, { method: 'PATCH', body: { name: 'stolen' } }, Bt)).status === 404
    && (await j('/api/auto-replies', { method: 'POST', body: { name: 'B rule', keywords: ['p'], steps: [{ type: 'product', product_id: pa.id }] } }, Bt)).status === 400);
  await j('/api/products/' + pa.id, { method: 'DELETE' }, Bt);
  check('other company cannot delete a product', (await j('/api/products', {}, A.token)).data.products.some(p => p.id === pa.id));
  await j('/api/products/' + pa.id, { method: 'DELETE' }, A.token);
  // Media Library and Quick Message stay inside each company
  const lf = await (await fetch(B + '/api/media-library?filename=a.png&mime=image/png', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + A.token }, body: Buffer.from('x') })).json();
  const ar = (await j('/api/auto-replies', { method: 'POST', body: { name: 'A rule', keywords: ['hello'], steps: [{ type: 'text', text: 'Hi from A' }] } }, A.token)).data;
  check('other company cannot see library files', !(await j('/api/media-library', {}, Bt)).data.files.some(f => f.id === lf.id) && (await fetch(B + `/api/media-library/${lf.id}/file`, { headers: { Authorization: 'Bearer ' + Bt } })).status === 404);
  check('other company cannot see or use quick messages', !(await j('/api/auto-replies', {}, Bt)).data.some(r => r.id === ar.id)
    && (await j('/api/auto-replies/' + ar.id, { method: 'PATCH', body: { active: false } }, Bt)).status === 404
    && (await j('/api/auto-replies', { method: 'POST', body: { name: 'B rule', keywords: ['x'], steps: [{ type: 'file', text: 'y', media_id: lf.id }] } }, Bt)).status === 400);
  await j('/api/auto-replies/' + ar.id, { method: 'DELETE' }, A.token); await j('/api/media-library/' + lf.id, { method: 'DELETE' }, A.token);

  // Super admin
  check('normal admin cannot list companies', (await j('/api/super/companies', {}, Bt)).status === 403);
  const cos = (await j('/api/super/companies', {}, A.token)).data;
  const bId = su.data.user.company_id;
  check('super admin lists companies', Array.isArray(cos) && cos.some(c => c.id === bId));
  await j('/api/super/companies/' + bId, { method: 'PATCH', body: { status: 'paused' } }, A.token);
  await sleep(200);
  check('paused company is signed out', (await j('/api/conversations', {}, Bt)).status === 401);
  check('paused company cannot sign in', (await j('/api/auth/login', { method: 'POST', body: { email: `bea${tag}@beta.co`, password: 'pw123456' } })).status === 403);
  await j('/api/super/companies/' + bId, { method: 'PATCH', body: { status: 'active' } }, A.token);
  check('resumed company works again', (await j('/api/conversations', {}, Bt)).status === 200);

  // A company with no agents: a client who finished the bot must show under All, not only under Unassigned
  await inbound(sharedPhone, 'more info please', pid); await sleep(300); await inbound(sharedPhone, 'Bilal', pid); await sleep(600);
  const allB = (await j('/api/conversations?status=open', {}, Bt)).data, unB = (await j('/api/conversations?unassigned=true', {}, Bt)).data;
  check('a waiting chat with no agent shows under All and Unread', unB.length === 1 && allB.length === 1 && allB[0].id === unB[0].id
    && (await j('/api/conversations?status=open&view=unread', {}, Bt)).data.length === 1 && (await j('/api/conversations/counts', {}, Bt)).data.unread === 1);

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})();
