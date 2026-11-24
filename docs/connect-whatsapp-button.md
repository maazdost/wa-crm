# "Connect WhatsApp" button: one-time Meta setup

The button lets a client connect their own WhatsApp number by signing in with Facebook in a popup. They don't copy any IDs or tokens. It's free from Meta. The client only pays Meta's normal per-message fees, and Meta asks them for a payment method inside the popup.

The button stays **hidden** until the three settings in step 6 are on the server. Until then, numbers can still be added by hand under Settings > WhatsApp numbers.

Do steps 1 to 5 **once** for your company. Step 6 is per client copy.

## 1. Verify your business with Meta
1. Open business.facebook.com > **Settings** > **Business info**. Check that the legal name, address and website (`https://teaminboxpro.com`) are correct.
2. Open **Security Center** > **Start verification** and follow the steps. Meta usually replies in 1 to 5 days.

## 2. Create the Meta app
1. Open developers.facebook.com > **My Apps** > **Create App**.
2. Choose the use case **Connect with customers through WhatsApp**. Choose your verified business portfolio when asked.
3. Open **App settings** > **Basic** and fill in:
   - App domains: `teaminboxpro.com`
   - Privacy policy URL: `https://teaminboxpro.com/privacy.html`
   - Save. The **App ID** shown at the top is your `META_APP_ID`. Click **Show** next to **App secret**; that's your `META_APP_SECRET`. Don't send it to anyone; paste it only into Render (step 6).

## 3. Facebook Login for Business
1. In the app's left menu, add the product **Facebook Login for Business**.
2. Open its **Settings** and set:
   - Login with the JavaScript SDK: **Yes**
   - Allowed domains for the JavaScript SDK: add every client address, for example `https://app.teaminboxpro.com` and `https://wof.teaminboxpro.com`. Add each new client's address here too.
   - Valid OAuth redirect URIs: the same addresses.
3. Open **Configurations** > **Create configuration**:
   - Name: `Connect WhatsApp`
   - Login variation: **WhatsApp Embedded Signup**
   - Assets: **WhatsApp accounts**
   - Permissions: `whatsapp_business_management` and `whatsapp_business_messaging`
   - Save. The **Configuration ID** is your `META_CONFIG_ID`.

## 4. Webhook for the app
1. Open **WhatsApp** > **Configuration** in this new app.
2. Callback URL: `https://app.teaminboxpro.com/webhook`. Verify token: the value of `WA_VERIFY_TOKEN` on that Render service (read it in Render; don't paste it in chat).
3. Under **Webhook fields**, subscribe to **messages**. Also subscribe to **calls** if you use calling.

Each client copy still gets its own messages. The button tells Meta to send each client's messages to that client's own address (for example `https://wof.teaminboxpro.com/webhook`).

This is a **new** app. It doesn't touch the Meta webhook your current numbers use through Wati.

## 5. Become a Tech Provider (so outside businesses can use the button)
1. In the app dashboard, follow **Become a Tech Provider** (under WhatsApp > Quickstart or App Review).
2. Request **Advanced access** for `whatsapp_business_management` and `whatsapp_business_messaging`. Meta asks for a short screen recording of the Connect WhatsApp button working.
3. Switch the app to **Live** mode.

Until Meta approves this, the button works only for businesses where you are an admin. That's enough for testing with your own number.

## 6. Turn the button on for a client copy (Render)
In Render, open the client's service (for example **teaminbox-wof**) > **Environment** > **Add Environment Variable**. Add:

| Key | Value |
| --- | --- |
| `META_APP_ID` | App ID from step 2 |
| `META_CONFIG_ID` | Configuration ID from step 3 |
| `META_APP_SECRET` | App secret from step 2 |
| `WA_APP_SECRET` | the same App secret. This lets the server check that webhook messages really come from Meta. **Don't add this one to the main app while it still gets messages through Wati.** |

Also check that `APP_URL` is the client's own address (for example `https://wof.teaminboxpro.com`) and that `WA_VERIFY_TOKEN` is set. Click **Save, rebuild and deploy**.

## What the client does
1. They sign in to their copy **in a computer browser**. The Facebook popup does not open inside the Android app.
2. They go to **Settings** > **WhatsApp numbers** > **Connect WhatsApp**.
3. In the popup, they sign in with Facebook, pick or create their business and WhatsApp account, add their number and confirm it with the SMS code.
4. When the popup closes, they choose a 6-digit PIN (WhatsApp two-step verification) and write it down. If the number already has a PIN, they type that one.
5. The number appears in the list with green ticks. Messages now arrive in the inbox.

Important: a number can be on only one system at a time. A number that is still in Wati or the WhatsApp Business phone app must be moved out of it first.
