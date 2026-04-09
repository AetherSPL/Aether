const CACHE_NAME = 'aetherscan-v1';
const PRECACHE = ['/', '/favicon.svg', '/logo.svg', '/icon-192.svg', '/manifest.json'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(PRECACHE)).then(()=>self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch', e => { if(e.request.method!=='GET')return; e.respondWith(caches.match(e.request).then(c=>{if(c)return c;return fetch(e.request).then(r=>{if(!r||r.status!==200)return r;const cl=r.clone();caches.open(CACHE_NAME).then(c=>c.put(e.request,cl));return r;}); })); });
