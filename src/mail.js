// Sends email over HTTPS (no extra packages, and works on hosts that block SMTP ports).
// Set RESEND_API_KEY (resend.com) or BREVO_API_KEY (brevo.com), plus MAIL_FROM, e.g.  Team Inbox <no-reply@yourdomain.com>
// Without a key the message is only printed in the server log, so nothing breaks while testing.
const parseFrom = (s) => { const m = /^(.*)<(.+)>$/.exec(String(s || '').trim()); return m ? { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() } : { name: '', email: String(s || '').trim() }; };

async function send({ to, subject, html, text }) {
  const from = process.env.MAIL_FROM;
  if (process.env.RESEND_API_KEY) {
    if (!from) throw new Error('MAIL_FROM is not set');
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html, text }) });
    if (!r.ok) throw new Error('Resend rejected the email: ' + (await r.text()).slice(0, 200));
    return { sent: true };
  }
  if (process.env.BREVO_API_KEY) {
    const f = parseFrom(from); if (!f.email) throw new Error('MAIL_FROM is not set');
    const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { email: f.email, ...(f.name ? { name: f.name } : {}) }, to: [{ email: to }], subject, htmlContent: html, textContent: text }) });
    if (!r.ok) throw new Error('Brevo rejected the email: ' + (await r.text()).slice(0, 200));
    return { sent: true };
  }
  console.log(`[mail not configured] To: ${to}\nSubject: ${subject}\n${text}`);
  return { sent: false };
}
module.exports = { send };
