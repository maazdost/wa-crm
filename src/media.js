const { query } = require('./db');
const wa = require('./whatsapp');

// Returns the stored file, downloading it from Meta first if we do not have it yet.
async function ensure(waMediaId) {
  const hit = (await query('SELECT * FROM media WHERE wa_media_id=$1', [waMediaId])).rows[0];
  if (hit) return hit;
  const { buffer, mime } = await wa.downloadMedia(waMediaId);
  return (await query(
    `INSERT INTO media(wa_media_id,mime,size,data) VALUES($1,$2,$3,$4)
     ON CONFLICT (wa_media_id) DO UPDATE SET mime=EXCLUDED.mime RETURNING *`, [waMediaId, mime, buffer.length, buffer])).rows[0];
}
async function store(waMediaId, mime, buffer) {
  await query(`INSERT INTO media(wa_media_id,mime,size,data) VALUES($1,$2,$3,$4) ON CONFLICT (wa_media_id) DO NOTHING`,
    [waMediaId, mime, buffer.length, buffer]);
}
// WhatsApp accepts only some formats as photo/video/audio; everything else is sent as a document.
function kindOf(mime = '') {
  if (/^image\/(jpeg|png)$/.test(mime)) return 'image';
  if (/^video\/(mp4|3gpp)$/.test(mime)) return 'video';
  if (/^audio\/(aac|mp4|mpeg|amr|ogg)/.test(mime)) return 'audio';
  return 'document';
}
module.exports = { ensure, store, kindOf };
