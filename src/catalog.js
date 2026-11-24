// Catalogs: the products a company sells. A product can be sent into a chat by an agent or by a Quick Message.
// It goes out as its photo (kept in the Media Library) with the name, price, details and link as the caption,
// or as plain text when the product has no photo.
const { query } = require('./db');
const wa = require('./whatsapp');
const mediaStore = require('./media');
const { saveOutbound } = require('./messages');

const CURRENCIES = ['PKR', 'USD', 'AED', 'SAR', 'GBP', 'EUR', 'INR'];
const money = (p) => p.price == null || p.price === '' ? '' : `${p.currency || 'PKR'} ${Number(p.price).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** The WhatsApp text for one product. Lines that are empty are left out. */
function caption(p) {
  const head = [money(p), p.in_stock ? '' : 'Out of stock'].filter(Boolean).join(' · ');
  return [`*${p.name}*` + (head ? `\n${head}` : ''), p.description, p.link].map(s => String(s || '').trim()).filter(Boolean).join('\n\n').slice(0, 1024);
}

/** Sends one product into a chat and returns the saved message. */
async function send(conv, waId, product, { senderType = 'bot', senderId = null } = {}) {
  const text = caption(product);
  const file = product.media_id ? (await query('SELECT * FROM media_library WHERE id=$1 AND company_id=$2', [product.media_id, product.company_id])).rows[0] : null;
  let msg;
  if (file && mediaStore.kindOf(file.mime) === 'image') {
    msg = await require('./autoreply').sendLibraryFile(conv, waId, file, { caption: text, senderType, senderId });
  } else {
    const r = await wa.forConversation(conv).sendText(waId, text);
    msg = await saveOutbound(conv, { senderType, senderId, body: text, waMessageId: r.messages?.[0]?.id });
  }
  await query('UPDATE products SET sent_count = sent_count + 1 WHERE id=$1', [product.id]);
  return msg;
}
module.exports = { CURRENCIES, money, caption, send };
