# Sales website

A small, fast static website that sells the product. It is separate from the app, so it never slows the inbox down.

Files:
- `index.html` – the whole home page
- `privacy.html` – privacy policy (Meta asks for one when you verify your business)
- `config.js` – **the only file you normally edit**: product name, sales WhatsApp number, email, app link, Android link, prices
- `favicon.svg`, `robots.txt`

## Put it online (free, on Render)
1. render.com > **New** > **Static Site**.
2. Pick the `wa-crm` GitHub repository.
3. Fill in:
   - Name: `teaminbox-website` (any name)
   - Branch: `main`
   - Root Directory: `website`
   - Build Command: leave empty
   - Publish Directory: `.`
4. Click **Create Static Site**. After a minute you get an address like `https://teaminbox-website.onrender.com`.
5. Optional: Settings > Custom Domains to use your own domain (for example `www.yourbrand.com`).

Static sites on Render never sleep, so the page opens instantly.

## Change the details
Edit `config.js` on GitHub (pencil icon), change the text between the quotes, and commit. Render updates the site in about a minute.
