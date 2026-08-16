// MicroTester Progressive Web App - Service Worker
const CACHE_NAME = 'microtester-v2';

const ASSETS_TO_CACHE = [
  './',
  'start.html',
  'main.html',
  'manifest.json',
  'css/common.css',
  'css/start.css',
  'css/main.css',
  'js/app.js',
  'js/voltmeter.js',
  'js/oscilloscope.js',
  'js/comp_tester.js',
  'js/siggen.js',
  'js/pwmdac.js',
  'js/calibration.js',
  'js/usb_protocol.js',
  'js/dfu.js',
  'js/dfuse.js',
  'img/icon.svg',
  'img/stm32f401.svg',
  'firmware/MicroTester_STM32F401.bin'
];

// Install: Cache all offline assets & firmware binary
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[PWA SW] Pre-caching all app assets and firmware binary...');
      return Promise.all(
        ASSETS_TO_CACHE.map((url) => {
          return cache.add(url).catch((err) => {
            console.warn(`[PWA SW] Failed to cache: ${url}`, err);
          });
        })
      );
    })
  );
  self.skipWaiting();
});

// Activate: Cleanup old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[PWA SW] Removing legacy cache:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch: Cache-First strategy with network fallback
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Fetch background update for cache if online
        fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, networkResponse);
              });
            }
          })
          .catch(() => {});
        return cachedResponse;
      }

      // Not in cache: fetch from network and store in cache
      return fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Offline fallback for HTML navigation
          if (event.request.mode === 'navigate') {
            return caches.match('start.html') || caches.match('main.html');
          }
        });
    })
  );
});
