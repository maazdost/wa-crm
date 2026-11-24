/*
  WEBSITE SETTINGS — this is the only file you need to edit.
  Change the text between the quotes, save, and push to GitHub. Render updates the site by itself.
*/
window.SITE = {
  // Product name shown across the website
  brand: 'TeamInbox Pro',

  // Your sales WhatsApp number in international format, digits only, no + or spaces (example: '923001234567').
  // The "Book a demo" form and every WhatsApp button open a chat with this number.
  salesWhatsApp: '',

  // Your sales email. Used when no WhatsApp number is set, and shown in the footer.
  salesEmail: 'sales@teaminboxpro.com',

  // Address of the live app, so existing customers can sign in (example: 'https://app.yourdomain.com').
  appUrl: 'https://app.teaminboxpro.com',

  // Link to the Android app download (APK) or Play Store page. Leave empty to hide the download button.
  androidUrl: '',

  // Currency shown in front of prices
  currency: 'PKR',

  // Plans. Leave price as '' to show "Custom quote" instead of a number.
  plans: [
    {
      name: 'Starter',
      price: '',
      period: '/ month',
      tagline: 'For a small team on one number',
      features: ['1 WhatsApp number', 'Up to 3 agents', 'Shared inbox, labels and notes', 'Welcome bot and away message', 'Android app with alerts']
    },
    {
      name: 'Growth',
      price: '',
      period: '/ month',
      tagline: 'For sales teams that want structure',
      highlight: true,
      features: ['Up to 3 WhatsApp numbers', 'Up to 10 agents', 'Departments and auto assignment', 'Broadcasts and follow-up sequences', 'Reports on reply time and sources']
    },
    {
      name: 'Business',
      price: '',
      period: '',
      tagline: 'For larger teams and several brands',
      features: ['Unlimited numbers and agents', 'Priority setup and training', 'WhatsApp calling (beta)', 'Custom bot messages per number', 'Dedicated support line']
    }
  ]
};
