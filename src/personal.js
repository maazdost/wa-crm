const { query } = require('./db');
// Marks a number as "not a client": deletes any chat stored for it, stops follow-ups, and the system ignores it from now on.
async function markPersonal(contactId) {
  await query('UPDATE contacts SET is_personal=TRUE WHERE id=$1', [contactId]);
  await query(`UPDATE drip_enrollments SET status='stopped' WHERE contact_id=$1 AND status='active'`, [contactId]);
  const c = (await query('SELECT id FROM conversations WHERE contact_id=$1', [contactId])).rows[0];
  if (c) {
    await query('DELETE FROM notes WHERE conversation_id=$1', [c.id]);
    await query('DELETE FROM messages WHERE conversation_id=$1', [c.id]);
    await query('DELETE FROM conversations WHERE id=$1', [c.id]);
  }
}
module.exports = { markPersonal };
