// Which NyxPrism backend this copy of the site talks to.
// Live site (nyxprism.com) -> production. Vercel preview links -> staging, once
// STAGING_API is filled in (see STAGING.md). Anything else -> production.
(function () {
  var PRODUCTION_API = 'https://nyxprism-production.up.railway.app';
  var STAGING_API = ''; // e.g. 'https://nyxprism-staging.up.railway.app'
  var host = location.hostname;
  var live = host === 'www.nyxprism.com' || host === 'nyxprism.com' || host === 'nyx-prism.vercel.app' || host === 'nyx-prism-connie-s-projects-97efb420.vercel.app' || host === 'nyx-prism-git-main-connie-s-projects-97efb420.vercel.app';
  var preview = /\.vercel\.app$/.test(host);
  // On the live site the API is reached through our own domain (vercel.json proxies /api/* to
  // Railway), so browser extensions and firewalls that block *.up.railway.app can't break the app.
  window.NYX_API = live ? location.origin : (preview && STAGING_API ? STAGING_API : PRODUCTION_API);
  window.NYX_ENV = live || window.NYX_API === PRODUCTION_API ? 'production' : 'staging';
  // Google Drive / Dropbox import and Save to Drive. Fill in to switch on (see CLOUD_SETUP.md).
  window.NYX_CLOUD = { googleClientId: '', googleApiKey: '', dropboxAppKey: '' };
  if (window.NYX_ENV === 'staging') {
    document.addEventListener('DOMContentLoaded', function () {
      var tag = document.createElement('div');
      tag.textContent = 'STAGING - test data only';
      tag.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;background:#f59e0b;color:#111;font:700 12px/1 Inter,system-ui,sans-serif;padding:8px 10px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.35)';
      document.body.appendChild(tag);
    });
  }
})();
