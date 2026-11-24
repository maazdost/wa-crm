// Which company (tenant) the current request or job belongs to.
// Every request is signed in to exactly one company; background jobs and webhooks set it per row.
// cid() throws when nothing set it, so a forgotten spot fails loudly instead of touching the wrong company's data.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

const run = (companyId, fn) => als.run({ cid: Number(companyId) }, fn);
function cid() {
  const s = als.getStore();
  if (!s || !s.cid) throw new Error('No company selected for this action');
  return s.cid;
}
const maybe = () => (als.getStore() || {}).cid || null;

// Emails in SUPER_ADMIN_EMAILS (comma separated) can see and pause every company.
const isSuper = (email) => (process.env.SUPER_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).includes(String(email || '').toLowerCase());

module.exports = { run, cid, maybe, isSuper };
