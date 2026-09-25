# Google Drive and Dropbox buttons

The "Or import from: Google Drive / Dropbox" row under each tool, and the
"Save to Google Drive" button after a download, stay hidden until the keys
below are filled in in `docs/config.js`:

```js
window.NYX_CLOUD = { googleClientId: '', googleApiKey: '', dropboxAppKey: '' };
```

These are public browser keys, not secrets. They are safe to commit. You can
turn on either service by itself.

## Google Drive (about 10 minutes)

1. Go to https://console.cloud.google.com and create a project called **NyxPrism**.
2. Under **APIs & Services > Library**, enable **Google Drive API** and **Google Picker API**.
3. Under **APIs & Services > OAuth consent screen**:
   - choose **External**;
   - app name **NyxPrism**, support email and logo;
   - authorised domain `nyxprism.com`;
   - privacy policy `https://www.nyxprism.com/privacy`;
   - add the scopes `.../auth/drive.readonly` and `.../auth/drive.file`;
   - publish the app.

   Google may ask to verify the app because of the `drive.readonly` scope. Until it is verified, users see an "unverified app" warning.
4. Under **Credentials > Create credentials > OAuth client ID**:
   - type **Web application**;
   - authorised JavaScript origins `https://www.nyxprism.com` and `https://nyxprism.com`.

   Copy the **Client ID** into `googleClientId`.
5. Under **Credentials > Create credentials > API key**:
   - restrict it to **HTTP referrers** `https://www.nyxprism.com/*` and `https://nyxprism.com/*`;
   - restrict the APIs to Google Picker API.

   Copy it into `googleApiKey`.

## Dropbox (about 5 minutes)

1. Go to https://www.dropbox.com/developers/apps and choose **Create app**.
2. Choose **Scoped access** and **Full Dropbox**, and name the app **NyxPrism**.
3. On the app's **Settings** tab, add `www.nyxprism.com` and `nyxprism.com` under **Chooser / Saver / Embedder domains**.
4. Copy the **App key** into `dropboxAppKey`.

## After adding keys

Commit and push `docs/config.js`. Vercel redeploys, and the buttons appear on
every tool. The site's security policy in `vercel.json` already allows the
Google and Dropbox scripts.
