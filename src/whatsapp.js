const crypto = require('crypto');
const { WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN, WA_API_VERSION = 'v21.0', WA_DRY_RUN, WA_APP_SECRET } = process.env;
const DRY = WA_DRY_RUN === 'true';

async function call(payload) {
  if (DRY) {
    console.log('[WA dry-run]', JSON.stringify(payload));
    return { messages: [{ id: 'dry_' + crypto.randomUUID() }] };
  }
  const res = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload })
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message || 'WhatsApp API error');
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

const sendText = (to, body) => call({ to, type: 'text', text: { body, preview_url: true } });

const sendButtons = (to, body, buttons) => call({
  to, type: 'interactive',
  interactive: {
    type: 'button', body: { text: body },
    action: { buttons: buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) }
  }
});

const sendTemplate = (to, name, language = 'en', params = []) => call({
  to, type: 'template',
  template: {
    name, language: { code: language },
    components: params.length ? [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }] : []
  }
});

const GRAPH = () => `https://graph.facebook.com/${WA_API_VERSION}`;
const AUTH = () => ({ Authorization: `Bearer ${WA_ACCESS_TOKEN}` });
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function uploadMedia(buffer, mime, filename) {
  if (DRY) return { id: 'dryM_' + crypto.randomUUID() };
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp'); fd.append('type', mime);
  fd.append('file', new Blob([buffer], { type: mime }), filename);
  const res = await fetch(`${GRAPH()}/${WA_PHONE_NUMBER_ID}/media`, { method: 'POST', headers: AUTH(), body: fd });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Media upload failed');
  return d;
}
async function downloadMedia(id) {
  if (DRY) return { buffer: Buffer.from(TINY_PNG, 'base64'), mime: 'image/png' };
  const meta = await (await fetch(`${GRAPH()}/${id}`, { headers: AUTH() })).json();
  if (!meta.url) throw new Error(meta.error?.message || 'Media not found');
  const r = await fetch(meta.url, { headers: AUTH() });
  if (!r.ok) throw new Error('Media download failed');
  return { buffer: Buffer.from(await r.arrayBuffer()), mime: meta.mime_type || r.headers.get('content-type') };
}
const sendMedia = (to, kind, id, { caption, filename } = {}) => call({
  to, type: kind,
  [kind]: { id, ...(caption && kind !== 'audio' ? { caption } : {}), ...(kind === 'document' && filename ? { filename } : {}) }
});

async function createTemplate(payload) {
  if (DRY) return { id: 'dry_t_' + crypto.randomUUID(), status: 'APPROVED' };
  if (!process.env.WA_WABA_ID) throw new Error('WA_WABA_ID is not set on the server');
  const res = await fetch(`${GRAPH()}/${process.env.WA_WABA_ID}/message_templates`, { method: 'POST', headers: { ...AUTH(), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.error_user_msg || d?.error?.message || 'Template request failed');
  return d;
}
async function listTemplates() {
  if (DRY) return [];
  if (!process.env.WA_WABA_ID) throw new Error('WA_WABA_ID is not set on the server');
  let url = `${GRAPH()}/${process.env.WA_WABA_ID}/message_templates?fields=name,status,language,category,components,rejected_reason&limit=100`; const out = [];
  while (url) { const d = await (await fetch(url, { headers: AUTH() })).json(); if (d.error) throw new Error(d.error.message); out.push(...(d.data || [])); url = d.paging && d.paging.next; }
  return out;
}

const markRead = (waMessageId) => DRY ? null : call({ status: 'read', message_id: waMessageId }).catch(() => {});

function verifySignature(rawBody, header) {
  if (!WA_APP_SECRET) return true; // allow during first tests; set WA_APP_SECRET in production
  if (!header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', WA_APP_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { createTemplate, listTemplates, uploadMedia, downloadMedia, sendMedia, sendText, sendButtons, sendTemplate, markRead, verifySignature };
