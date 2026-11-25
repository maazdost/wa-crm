// The app opens your live server, so web updates reach every phone without a new APK.
// SERVER_URL is your backend address, e.g. https://wa-crm-backend.onrender.com
     const url = process.env.SERVER_URL;
     module.exports = {
       appId: 'com.horizon.teaminbox',
       appName: 'Team Inbox',
       webDir: 'www',
       // allowNavigation keeps a client's own copy (name.teaminboxpro.com) inside the app instead of opening the phone's browser
       ...(url ? { server: { url, cleartext: url.startsWith('http://'), allowNavigation: ['*.teaminboxpro.com'] } } : {}),
       android: { appendUserAgent: process.env.HAS_FIREBASE === '1' ? 'TeamInboxFCM' : '' },
       plugins: { PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] } }
     };
