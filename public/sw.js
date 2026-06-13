// AURA System Service Worker v4.4
const CACHE_NAME = 'aura-system-v4.4.0';
const STATIC_CACHE = 'aura-static-v4.4.0';
const API_CACHE = 'aura-api-v4.4.0';  // Separate cache for APIs

// Assets to cache during installation
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/styles.css',
  '/js/app.js',
  '/icons/icon-72x72.png',
  '/icons/icon-96x96.png',
  '/icons/icon-128x128.png',
  '/icons/icon-144x144.png',
  '/icons/icon-152x152.png',
  '/icons/icon-192x192.png',
  '/icons/icon-384x384.png',
  '/icons/icon-512x512.png',
  '/aura-logo.svg'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('🔄 AURA Service Worker installing...');
  
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        console.log('📦 Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('✅ AURA Service Worker installed');
        return self.skipWaiting();
      })
      .catch((error) => {
        console.error('❌ Cache installation failed:', error);
      })
  );
});

// Activate event - cleanup old caches
self.addEventListener('activate', (event) => {
  console.log('🚀 AURA Service Worker activating...');
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          // Keep only current caches
          if (cacheName !== STATIC_CACHE && cacheName !== API_CACHE && cacheName !== CACHE_NAME) {
            console.log('🗑️ Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('✅ AURA Service Worker activated');
      return self.clients.claim();
    })
  );
});

// Fetch event - network first for API, cache first for assets
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API requests - Network First strategy (GET only)
  if (url.pathname.startsWith('/api/')) {
    // Only cache GET requests, never POST/PUT/DELETE
    if (request.method === 'GET') {
      event.respondWith(
        fetch(request)
          .then((response) => {
            if (response.status === 200) {
              const responseClone = response.clone();
              caches.open(API_CACHE)
                .then((cache) => {
                  cache.put(request, responseClone);
                });
            }
            return response;
          })
          .catch(async () => {
            // Fallback to cache when offline
            const cachedResponse = await caches.match(request);
            if (cachedResponse) {
              return cachedResponse;
            }
            // Return error response for API
            return new Response(JSON.stringify({ 
              error: 'You are offline. Please check your connection.',
              offline: true 
            }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' }
            });
          })
      );
    } else {
      // POST, PUT, DELETE - never cache, always network
      event.respondWith(
        fetch(request).catch(() => {
          return new Response(JSON.stringify({ 
            error: 'Cannot perform this action while offline' 
          }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        })
      );
    }
    return;
  }

  // Static assets - Cache First strategy
  if (request.method === 'GET' && 
      (request.destination === 'document' || 
       request.destination === 'style' || 
       request.destination === 'script' || 
       request.destination === 'image')) {
    
    event.respondWith(
      caches.match(request)
        .then((cachedResponse) => {
          if (cachedResponse) {
            // Update cache in background
            fetchAndCache(request);
            return cachedResponse;
          }
          // Not in cache, fetch from network
          return fetchAndCache(request);
        })
        .catch(() => {
          // Ultimate fallback for offline
          if (request.destination === 'document') {
            return caches.match('/');
          }
          return new Response('Offline', { status: 503 });
        })
    );
    return;
  }
});

// Helper function to fetch and cache requests
async function fetchAndCache(request) {
  try {
    const response = await fetch(request);
    // Check if we received a valid response
    if (response && response.status === 200) {
      const responseToCache = response.clone();
      const cache = await caches.open(API_CACHE);
      await cache.put(request, responseToCache);
    }
    return response;
  } catch (error) {
    console.error('Fetch failed:', error);
    throw error;
  }
}

// Background sync for failed API requests
self.addEventListener('sync', (event) => {
  if (event.tag === 'background-sync') {
    console.log('🔄 Background sync triggered');
    event.waitUntil(doBackgroundSync());
  }
});

async function doBackgroundSync() {
  console.log('🔄 Performing background sync...');
  // Implement your background sync logic here
  // e.g., retry failed POST requests from IndexedDB
}

// Push notifications
self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const data = event.data.json();
    const options = {
      body: data.body || 'AURA System Notification',
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-72x72.png',  // Fixed badge path
      vibrate: [100, 50, 100],
      data: {
        url: data.url || '/'
      },
      actions: [
        {
          action: 'open',
          title: 'Open AURA'
        },
        {
          action: 'close',
          title: 'Dismiss'
        }
      ]
    };

    event.waitUntil(
      self.registration.showNotification(data.title || 'AURA AI', options)
    );
  } catch (error) {
    console.error('Push notification error:', error);
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'open') {
    event.waitUntil(
      clients.matchAll({ type: 'window' }).then((clientList) => {
        for (const client of clientList) {
          if (client.url === '/' && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow('/');
        }
      })
    );
  }
});
