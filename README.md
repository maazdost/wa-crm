# WA CRM backend

## Run locally
1. `cp .env.example .env` and fill it in (use `WA_DRY_RUN=true` to test without Meta)
2. `npm install && npm run seed && npm start`
3. In another terminal: `npm test` (end-to-end check of bot, assignment, sticky ownership, window rules)

## Free test deployment (Render + Neon)
1. Create a free Postgres at neon.tech and copy its connection string.
2. Push this folder to a GitHub repo, then on render.com choose New > Blueprint (uses render.yaml).
3. Set DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD and the WA_* values in Render.
4. Open the Render shell (or run locally against the Neon URL) and run `npm run seed` once.
5. In Meta developer dashboard > WhatsApp > Configuration, set the webhook to
   `https://<your-service>.onrender.com/webhook` with your WA_VERIFY_TOKEN, and subscribe to "messages".

Note: Render's free service sleeps after ~15 minutes idle, so the first message after a quiet spell can be delayed.
Fine for testing; move to a paid instance or your own server for live traffic.

## Web app
The agent/manager web app lives in `public/index.html` and is served by the same server.
Open `https://<your-service>.onrender.com/` and sign in with ADMIN_EMAIL / ADMIN_PASSWORD.
Admins add agents from the Team screen. The same file is what the Android app will wrap.

## Media
Agents can attach photos (JPEG/PNG, up to 5 MB), videos (MP4), audio and documents (up to 16 MB) with the Attach
button, or paste an image. Client photos, voice notes, videos and documents show inside the chat. Files are kept in
the database, which is fine for testing. For heavy live use move them to object storage (S3 or Cloudflare R2).

## Android app
The app is a thin shell that opens your live server, so web changes reach phones without a new APK.
1. Put this whole folder in a GitHub repository.
2. Repository > Settings > Secrets and variables > Actions > Variables: add `SERVER_URL` = your backend address (https://...).
3. Actions tab > "Build Android app" > Run workflow. When it finishes, download the `team-inbox-apk` artifact and
   unzip it to get `app-debug.apk`. Send it to agents; they allow "install unknown apps" once and install it.

### Push notifications (optional, needed for alerts when the app is closed)
1. console.firebase.google.com > create a project > add an Android app with package name `com.horizon.teaminbox`.
2. Download `google-services.json`. In GitHub add a repository *secret* `GOOGLE_SERVICES_JSON` with the full file contents.
3. Firebase > Project settings > Service accounts > Generate new private key. Paste the whole JSON into the
   `FIREBASE_SERVICE_ACCOUNT` environment variable on your server.
4. Run the "Build Android app" workflow again and reinstall the APK.
Without these steps the app still works; agents get alerts only while it is open.
