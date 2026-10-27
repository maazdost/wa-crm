const { query } = require('./db');
const wa = require('./whatsapp');
const { saveOutbound } = require('./messages');
const first = (n) => (n || '').trim().split(/\s+/)[0] || 'there';

// Called when a client is handed to an agent: joins every active follow-up sequence.
async function enroll(contactId) {
  const ds = (await query(`SELECT id, steps FROM drips WHERE active`)).rows;
  for (const d of ds) {
    if (!d.steps.length) continue;
    await query(`INSERT INTO drip_enrollments(drip_id,contact_id,next_at) VALUES($1,$2, now() + ($3 || ' hours')::interval) ON CONFLICT DO NOTHING`,
      [d.id, contactId, String(d.steps[0].delay_hours || 0)]);
  }
}

async function runDue() {
  const due = (await query(
    `SELECT e.*, d.steps, d.stop_on_reply, ct.wa_id, ct.opted_out, ct.is_personal, COALESCE(ct.profile_name, ct.name) AS cname
       FROM drip_enrollments e JOIN drips d ON d.id=e.drip_id AND d.active JOIN contacts ct ON ct.id=e.contact_id
      WHERE e.status='active' AND e.next_at <= now() ORDER BY e.next_at LIMIT 20`)).rows;
  for (const e of due) {
    try {
      if (e.opted_out || e.is_personal) { await query(`UPDATE drip_enrollments SET status='stopped' WHERE id=$1`, [e.id]); continue; }
      if (e.stop_on_reply) {
        const replied = (await query(
          `SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.contact_id=$1 AND m.direction='in' AND m.created_at > $2 LIMIT 1`, [e.contact_id, e.enrolled_at])).rows[0];
        if (replied) { await query(`UPDATE drip_enrollments SET status='stopped' WHERE id=$1`, [e.id]); continue; }
      }
      const s = e.steps[e.step];
      const t = (await query('SELECT * FROM templates WHERE name=$1', [s.template])).rows[0];
      if (!t || (t.status !== 'APPROVED' && process.env.WA_DRY_RUN !== 'true')) { await query(`UPDATE drip_enrollments SET status='stopped' WHERE id=$1`, [e.id]); continue; }
      const params = (s.var_map || []).map(m => m.type === 'name' ? first(e.cname) : String(m.value || ''));
      const sent = await wa.sendTemplate(e.wa_id, t.name, t.language, params);
      const conv = (await query('SELECT * FROM conversations WHERE contact_id=$1', [e.contact_id])).rows[0];
      if (conv) await saveOutbound(conv, { senderType: 'bot', type: 'template', templateName: t.name, waMessageId: sent.messages?.[0]?.id,
        body: t.body.replace(/\{\{(\d+)\}\}/g, (_, i) => params[i - 1] ?? '') });
      const nxt = e.steps[e.step + 1];
      if (nxt) await query(`UPDATE drip_enrollments SET step=step+1, next_at=now() + ($2 || ' hours')::interval WHERE id=$1`, [e.id, String(nxt.delay_hours || 0)]);
      else await query(`UPDATE drip_enrollments SET status='done', step=step+1 WHERE id=$1`, [e.id]);
    } catch (err) { console.error('follow-up', err.message); await query(`UPDATE drip_enrollments SET next_at = now() + interval '30 minutes' WHERE id=$1`, [e.id]); }
  }
}
let busy = false;
const start = () => setInterval(async () => { if (busy) return; busy = true; try { await runDue(); } finally { busy = false; } }, Number(process.env.DRIP_TICK_MS || 20000));
module.exports = { enroll, start };
