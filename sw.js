// Heritage Bank Service Worker - Offline support & caching
const CACHE_NAME = 'heritage-bank-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/signin.html',
  '/styles.css',
  '/script.js',
  '/app-layout.css',
  '/app-sidebar.js',
  '/assets/favicon.svg',
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

// Fetch - network first for API, cache first for static
self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // API calls - network only (don't cache sensitive banking data)
  if (url.pathname.startsWith('/api/')) return;

  // Static assets - stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      var fetched = fetch(event.request).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function() {
        // Network failed, try cache
        return cached;
      });
      return cached || fetched;
    })
  );
});
