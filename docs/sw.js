// NyxPrism Service Worker — network-first for HTML, cache-first for assets
const CACHE = 'nyx-v6';
const SHELL = [
  '/manifest.json',
  '/nyx-brand.css?v=3',
  '/prism-icon-192.png?v=2',
  '/prism-icon-512.png?v=2',
  '/prism-icon-maskable-512.png?v=2'
];
const SENSITIVE_HTML = new Set(['/admin.html', '/dashboard.html', '/distribution.html', '/login.html', '/sign-request.html']);

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) { return c.addAll(SHELL); })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  // Only handle same-origin GET requests
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  if (SENSITIVE_HTML.has(url.pathname)) {
    e.respondWith(fetch(e.request, { cache: 'no-store' }));
    return;
  }

  // HTML must refresh after deployments so auth and security fixes are not stale.
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        }
        return response;
      }).catch(function() { return caches.match(e.request); })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(function(cached) {
      var fetched = fetch(e.request).then(function(response) {
        if (response && response.status === 200 && response.type === 'basic') {
          var clone = response.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        }
        return response;
      });
      return cached || fetched;
    })
  );
});
