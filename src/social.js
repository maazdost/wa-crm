// Facebook and Instagram Automation: rules that answer a comment or a direct message by themselves.
// A rule says: when someone comments (or messages) a keyword, reply in public and/or send them a private message.
// Until a Facebook Page or Instagram account is connected (needs Meta business verification) rules can only be tried
// with "Try it" on the page, which runs this same code in test mode and sends nothing.
const { query } = require('./db');
const tenant = require('./tenant');
const { matches } = require('./autoreply');

const PLATFORMS = ['facebook', 'instagram'];
const TRIGGERS = ['comment', 'dm'];
// {{name}} and {{first_name}} in a reply become the name of the person who wrote
const fill = (text, name) => { const full = String(name || '').trim(); return String(text || '').replace(/\{\{\s*(name|first_name)\s*\}\}/gi, (_, k) => (k.toLowerCase() === 'name' ? full : full.split(/\s+/)[0]) || 'there'); };

/** The rule that should answer this comment or message, or null. Exact rules win over "contains", and "any comment" comes last. */
async function find(platform, trigger, text) {
  const rules = (await query(`SELECT * FROM social_rules WHERE company_id=$1 AND platform=$2 AND trigger=$3 AND active
    ORDER BY CASE match_type WHEN 'exact' THEN 0 WHEN 'contains' THEN 1 ELSE 2 END, id`, [tenant.cid(), platform, trigger])).rows;
  return rules.find(r => r.match_type === 'any' ? String(text || '').trim() !== '' : matches(r, text)) || null;
}

/**
 * Handles one comment or direct message: finds the rule, works out the replies and writes the log.
 * test=true (the "Try it" box) sends nothing. Real sending is added when a page can be connected.
 */
async function handle({ platform, trigger, text, name, test = false }) {
  const rule = await find(platform, trigger, text);
  if (!rule) return { matched: false };
  const reply = fill(rule.reply_text, name).trim(), priv = fill(rule.private_text, name).trim();
  await query('INSERT INTO social_log(company_id, rule_id, rule_name, platform, trigger, from_name, text, reply, private_reply, status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [tenant.cid(), rule.id, rule.name, platform, trigger, String(name || '').slice(0, 120), String(text || '').slice(0, 1000), reply, priv, test ? 'test' : 'sent']);
  if (!test) await query('UPDATE social_rules SET sent_count = sent_count + 1, last_sent_at = now() WHERE id=$1', [rule.id]);
  query(`DELETE FROM social_log WHERE created_at < now() - interval '60 days'`).catch(() => {});
  return { matched: true, rule: { id: rule.id, name: rule.name }, reply, private_reply: priv };
}
module.exports = { PLATFORMS, TRIGGERS, fill, find, handle };
