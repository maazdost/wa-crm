// Plans and limits for client companies.
// A company is on Free, Starter, Pro or Custom. Free, Starter and Pro take their limits from the plans table
// (the super admin can change them). Custom has its own limits saved on the company; an empty limit means "no limit".
// Existing companies start on Custom with no limits, so nothing changes for them.
// A Starter or Pro company whose trial end date has passed is treated as Free until its plan is changed. It is never paused.
const { query } = require('./db');
const tenant = require('./tenant');

const KEYS = ['members', 'numbers', 'broadcast', 'storage_mb', 'ai_replies'];
const PLAN_KEYS = ['free', 'starter', 'pro', 'custom'];
const ENV_MB = () => Math.max(1, Number(process.env.MEDIA_LIBRARY_MAX_MB) || 100);

// A limit sent from the page: empty means no limit, otherwise a whole number of 0 or more.
const num = (v) => { if (v === null || v === undefined || String(v).trim() === '') return null; const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? Math.min(n, 100000000) : null; };
const cleanLimits = (o) => Object.fromEntries(KEYS.map(k => [k, num((o || {})[k])]));

const plans = async () => (await query('SELECT key, name, members, numbers, broadcast, storage_mb, ai_replies FROM plans ORDER BY sort, key')).rows;

/** The plan of a company as it applies today: { plan, effective, name, trial_ends, trial_over, note, limits }. */
async function current(cid = tenant.cid()) {
  const co = (await query(`SELECT plan, to_char(trial_ends, 'YYYY-MM-DD') AS trial_ends, plan_note, limits,
      (trial_ends IS NOT NULL AND trial_ends < (now() AT TIME ZONE 'Asia/Karachi')::date) AS trial_over FROM companies WHERE id=$1`, [cid])).rows[0];
  if (!co) return { plan: 'custom', effective: 'custom', name: 'Custom', trial_ends: null, trial_over: false, limits: cleanLimits({}) };
  const paid = co.plan === 'starter' || co.plan === 'pro';
  const effective = paid && co.trial_over ? 'free' : co.plan;
  const row = effective === 'custom' ? null : (await query('SELECT * FROM plans WHERE key=$1', [effective])).rows[0];
  const all = await plans(), nameOf = (k) => k === 'custom' ? 'Custom' : (all.find(p => p.key === k) || { name: k }).name;
  return { plan: co.plan, effective, name: nameOf(effective), plan_name: nameOf(co.plan), trial_ends: paid ? co.trial_ends : null, trial_over: paid && co.trial_over,
    limits: cleanLimits(effective === 'custom' ? co.limits : row) };
}

/** What a company uses right now: active team members, WhatsApp numbers, broadcast messages and AI replies this month, library space. */
async function usage(cid = tenant.cid()) {
  const r = (await query(`SELECT
      (SELECT COUNT(*)::int FROM users WHERE company_id=$1 AND is_active) AS members,
      (SELECT COUNT(*)::int FROM wa_numbers WHERE company_id=$1) AS numbers,
      (SELECT COUNT(*)::int FROM broadcast_recipients r JOIN broadcasts b ON b.id=r.broadcast_id
        WHERE b.company_id=$1 AND b.created_at >= date_trunc('month', now()) AND (b.status <> 'cancelled' OR r.status <> 'queued')) AS broadcast,
      (SELECT COUNT(*)::int FROM ai_replies WHERE company_id=$1 AND result IN ('answered','handover') AND created_at >= date_trunc('month', now())) AS ai_replies,
      (SELECT COALESCE(SUM(size),0)::bigint FROM media_library WHERE company_id=$1) AS storage_bytes`, [cid])).rows[0];
  const bytes = Number(r.storage_bytes);
  return { members: r.members, numbers: r.numbers, broadcast: r.broadcast, ai_replies: r.ai_replies, storage_bytes: bytes, storage_mb: Math.round(bytes / 1048576 * 10) / 10 };
}

/** Library space of this company in MB: the plan's limit, or the server's own limit when the plan has none. */
async function storageMb() { const l = (await current()).limits.storage_mb; return l == null ? ENV_MB() : Math.max(1, l); }

/** Returns nothing when adding `add` more is inside the plan, or the message to show when it is not. */
async function check(kind, add = 1) {
  const p = await current(), lim = p.limits[kind];
  if (lim == null) return null;
  const used = (await usage())[kind];
  if (used + add <= lim) return null;
  if (kind === 'members') return `Your ${p.name} plan allows ${lim} team member${lim === 1 ? '' : 's'}. Switch someone off or contact us to upgrade your plan.`;
  if (kind === 'numbers') return `Your ${p.name} plan allows ${lim} WhatsApp number${lim === 1 ? '' : 's'}. Contact us to upgrade your plan.`;
  if (kind === 'broadcast') return `Your ${p.name} plan allows ${lim} broadcast messages a month. You have ${Math.max(0, lim - used)} left this month and this broadcast has ${add}.`;
  if (kind === 'ai_replies') return `Your ${p.name} plan allows ${lim} AI replies a month and they are used up. Clients go straight to your agents until next month.`;
  return 'Your plan does not allow this.';
}

module.exports = { KEYS, PLAN_KEYS, cleanLimits, plans, current, usage, check, storageMb };
