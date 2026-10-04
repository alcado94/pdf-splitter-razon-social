'use strict';

// Only application resources are cached; selected PDFs and generated files stay in memory.
const CACHE_PREFIX = 'pdf-splitter-shell-';
// Increment this version whenever a precached file changes in a release.
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const baseURL = new URL('./', self.location.href);
const assets = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'lib/pdf-lib.min.js',
  'lib/jszip.min.js',
  'utils/validation.js',
  'utils/filename.js',
  'services/pdf-reader.js',
  'services/field-extractor.js',
  'services/pdf-splitter.js',
  'services/zip-generator.js'
];
const assetURLs = new Set(assets.map((asset) => new URL(asset, baseURL).href));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([...assetURLs])));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !assetURLs.has(event.request.url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    // Recover if the browser has evicted a resource while a connection is available.
    const response = await fetch(event.request);
    if (response.ok) await cache.put(event.request, response.clone());
    return response;
  })());
});
