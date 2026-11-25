// Where a contact came from: the channel (WhatsApp, Facebook, Instagram...) and the ad they clicked.
const CHANNELS = ['whatsapp', 'facebook', 'instagram', 'tiktok', 'google', 'youtube', 'website', 'referral', 'walkin', 'other'];

// Only plain web links are kept, so nothing else can be opened from the Contacts page.
function cleanUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s || s.length > 1000) return null;
  try { const x = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); return /^https?:$/.test(x.protocol) && x.hostname.includes('.') ? x.href : null; } catch { return null; }
}
// The app behind a link: an Instagram post or ad, or a Facebook one.
function appOfUrl(u) {
  const h = (() => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } })();
  if (/(^|\.)(instagram\.com|instagr\.am|ig\.me)$/.test(h)) return 'instagram';
  if (/(^|\.)(facebook\.com|fb\.com|fb\.me|fb\.watch|m\.me)$/.test(h)) return 'facebook';
  if (/(^|\.)(tiktok\.com)$/.test(h)) return 'tiktok';
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(h)) return 'youtube';
  if (/(^|\.)(google\.[a-z.]+|g\.page|goo\.gl)$/.test(h)) return 'google';
  return null;
}
// Turns what a person or a file says ("FB", "Insta", "WATI", "Facebook Ads") into one of the channels, or keeps short own text.
function normChannel(v, url) {
  const s = String(v == null ? '' : v).trim(), t = s.toLowerCase().replace(/[\s_-]+/g, ' ');
  if (!t || /^[—–-]+$/.test(t)) return url ? appOfUrl(url) : null;
  if (CHANNELS.includes(t.replace(/ /g, ''))) return t.replace(/ /g, '');
  if (/insta|^ig\b/.test(t)) return 'instagram';
  if (/facebook|^fb\b|messenger|\bmeta\b/.test(t)) return 'facebook';
  if (/tik ?tok/.test(t)) return 'tiktok';
  if (/youtube|^yt\b/.test(t)) return 'youtube';
  if (/google/.test(t)) return 'google';
  if (/whats ?app|^wa\b|wati|organic|ctwa/.test(t)) return url ? appOfUrl(url) || 'whatsapp' : 'whatsapp';
  if (/web|site|landing|form/.test(t)) return 'website';
  if (/refer|friend|word of mouth/.test(t)) return 'referral';
  if (/walk|shop|store|visit/.test(t)) return 'walkin';
  if (/import|excel|csv|upload|^api$|manual|^other$/.test(t)) return url ? appOfUrl(url) : (t === 'other' ? 'other' : null);
  return s.slice(0, 30);
}
// The referral Meta adds to the first message after a click on a Click-to-WhatsApp ad or post.
function fromReferral(r) {
  if (!r || typeof r !== 'object') return null;
  const url = cleanUrl(r.source_url);
  const app = String(r.entry_point_conversion_app || r.source_app || '').toLowerCase();
  const channel = /insta/.test(app) ? 'instagram' : /facebook|fb/.test(app) ? 'facebook' : (url && appOfUrl(url)) || null;
  return { channel, url, type: String(r.source_type || 'ad').toLowerCase().slice(0, 20), id: r.source_id ? String(r.source_id).slice(0, 60) : null,
    headline: String(r.headline || r.body || '').trim().slice(0, 200) || null };
}
// A date from a file: an Excel day number, 2026-11-25 10:30, 25/11/2026, or "25 Nov 2026". Dates in the future or before 2000 are dropped.
function cleanDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || /^[—–-]+$/.test(s)) return null;
  let d;
  if (/^\d{5}(\.\d+)?$/.test(s)) d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
  else { const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?/i);
    if (m) { let h = +(m[4] || 0); if (m[7]) h = h % 12 + (/pm/i.test(m[7]) ? 12 : 0); d = new Date(+m[3], +m[2] - 1, +m[1], h, +(m[5] || 0), +(m[6] || 0)); if (d.getMonth() !== +m[2] - 1) return null; }
    else d = new Date(s.replace(/(\d)(st|nd|rd|th)\b/, '$1').replace(/,\s*(\d{1,2}:\d\d)/, ' $1')); }
  if (!d || isNaN(d)) return null;
  return d.getFullYear() < 2000 || d > new Date(Date.now() + 86400000) ? null : d.toISOString();
}
module.exports = { CHANNELS, cleanUrl, appOfUrl, normChannel, fromReferral, cleanDate };
