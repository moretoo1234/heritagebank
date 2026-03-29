// Heritage Bank Service Worker - Offline support & caching
const CACHE_VERSION = 4;
const CACHE_NAME = 'heritage-bank-v' + CACHE_VERSION;
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/signin.html',
  '/signup.html',
  '/styles.css',
  '/script.js',
  '/app-layout.css',
  '/app-sidebar.js',
  '/loading.css',
  '/cookie-consent.js',
  '/assets/favicon.svg',
  '/404.html',
  '/dashboard-page.css',
  '/open-account-enhanced.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

// Install - cache static assets
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

// Fetch - network first for API, stale-while-revalidate for static
self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // API calls - network only (don't cache sensitive banking data)
  if (url.pathname.startsWith('/api/')) return;

  // HTML pages behind auth - network only (never serve stale dashboard/account pages)
  var authPages = ['/dashboard', '/admin', '/analytics', '/settings', '/messages',
    '/statements', '/transactions', '/transfer', '/pay-bills', '/cards',
    '/investment', '/retirement', '/savings-goals', '/mobile-deposit', '/request-loan',
    '/bulk-payments'];
  if (authPages.some(function(p) { return url.pathname.startsWith(p); })) {
    event.respondWith(
      fetch(event.request).catch(function() {
        return caches.match('/404.html') || new Response('Offline', { status: 503 });
      })
    );
    return;
  }

  // Static assets & public pages - stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      var fetched = fetch(event.request).then(function(response) {
        if (response && response.status === 200 && response.type !== 'opaque') {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function() {
        // Network failed - return cached or offline fallback
        if (cached) return cached;
        if (event.request.destination === 'document') {
          return caches.match('/404.html');
        }
        return new Response('', { status: 503 });
      });
      return cached || fetched;
    })
  );
});
