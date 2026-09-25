// Which NyxPrism backend this copy of the site talks to.
// Live site (nyxprism.com) -> production. Vercel preview links -> staging, once
// STAGING_API is filled in (see STAGING.md). Anything else -> production.
(function () {
  var PRODUCTION_API = 'https://nyxprism-production.up.railway.app';
  var STAGING_API = ''; // e.g. 'https://nyxprism-staging.up.railway.app'
  var host = location.hostname;
  var live = host === 'www.nyxprism.com' || host === 'nyxprism.com';
  var preview = /\.vercel\.app$/.test(host);
  window.NYX_API = !live && preview && STAGING_API ? STAGING_API : PRODUCTION_API;
  window.NYX_ENV = window.NYX_API === PRODUCTION_API ? 'production' : 'staging';
  if (window.NYX_ENV === 'staging') {
    document.addEventListener('DOMContentLoaded', function () {
      var tag = document.createElement('div');
      tag.textContent = 'STAGING - test data only';
      tag.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;background:#f59e0b;color:#111;font:700 12px/1 Inter,system-ui,sans-serif;padding:8px 10px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.35)';
      document.body.appendChild(tag);
    });
  }
})();
