// Ad routing: a client who comes from a Click-to-WhatsApp ad skips the welcome menu and goes straight to the department
// set for that ad. A rule matches when one of its words is in the ad's headline, its link or its ad id
// (Meta sends these with the first message after the click). Managers set the rules on the Ad routing page.
// Everything here works only for the company of the current request or job.
const { query } = require('./db');
const tenant = require('./tenant');
const autoreply = require('./autoreply');
const { assignConversation } = require('./assign');

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const haystack = (ref) => norm([ref && ref.headline, ref && ref.url, ref && ref.id].filter(Boolean).join(' '));
// In the client's own words a rule word must be a whole word (a short ending like "classes" for "class" is fine), so "prop" does not match "property".
const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const saidHits = (rule, said) => !!said && (Array.isArray(rule.keywords) ? rule.keywords : []).map(norm).filter(Boolean).some(k => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(k)}[\\p{L}]{0,2}($|[^\\p{L}\\p{N}])`, 'u').test(said));
const hits = (rule, text) => !!text && (Array.isArray(rule.keywords) ? rule.keywords : []).map(norm).filter(Boolean).some(k => text.includes(k));

/**
 * The switched-on rule that fits this ad, or null. ref is what source.fromReferral() made of the click (may be null).
 * firstText is the client's first message: an ad's ready-made first message ("I'm interested in a Scaling Account") is checked too,
 * because Meta does not always send the ad details (boosted posts, wa.me links), and the headline may not carry the rule's word.
 */
async function find(ref, firstText) {
  const text = haystack(ref), said = norm(firstText); if (!text && !said) return null;
  const rules = (await query('SELECT * FROM ad_rules WHERE company_id=$1 AND active ORDER BY id', [tenant.cid()])).rows;
  return rules.find(r => hits(r, text)) || rules.find(r => saidHits(r, said)) || null;
}

/** Which rule an ad (from the list of ads) goes to, for the Ad routing page. */
const ruleFor = (rules, ad) => rules.find(r => r.active && hits(r, haystack(ad))) || null;

/**
 * Sends the client to the rule's department: the department is set, the welcome chatbot's greeting and the rule's short message go out, and the chat goes to the next
 * agent of that department. Returns the same shape as a finished chatbot, so the webhook tells the team the same way.
 */
async function run(rule, conv, contact, waId) {
  const wasNew = conv.status === 'bot';
  await query(`UPDATE conversations SET team=CASE WHEN EXISTS (SELECT 1 FROM departments WHERE company_id=$3 AND key=$2) THEN $2 ELSE team END, bot_step='done', ad_rule_id=$4 WHERE id=$1`, [conv.id, rule.team, tenant.cid(), rule.id]);
  await query('UPDATE ad_rules SET hits = hits + 1, last_hit_at = now() WHERE id=$1', [rule.id]);
  let next = (await query('SELECT * FROM conversations WHERE id=$1', [conv.id])).rows[0];
  // First the welcome chatbot's greeting (welcome text, community link), without its menu questions, then the ad's own message.
  await require('./flows').sendGreeting(next, contact, waId).catch(e => console.error('ad greeting', e.message));
  if (rule.message) await autoreply.sendStep({ id: 0 }, next, waId, contact, { type: 'text', text: rule.message, buttons: [] }).catch(e => console.error('ad routing message', e.message));
  const owner = next.assigned_to && (await query('SELECT is_active FROM users WHERE id=$1', [next.assigned_to])).rows[0];
  if (owner?.is_active) next = (await query(`UPDATE conversations SET status='open' WHERE id=$1 RETURNING *`, [conv.id])).rows[0];
  else next = (await assignConversation(conv.id, next.team)) || (await query('SELECT * FROM conversations WHERE id=$1', [conv.id])).rows[0];
  if (wasNew) require('./drip').enroll(contact.id).catch(e => console.error('follow-up enroll', e.message));
  return { conversation: next, finished: true, flow: { name: 'Ad: ' + rule.name }, newlyAssigned: !!next.assigned_to };
}

module.exports = { find, run, ruleFor, haystack };
