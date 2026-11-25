'use strict';
var cacheName = 'motr-iphone-shell-v1';
var assets = [
  './', './index.html', './app.css', './app.js', './backend.js', './tracking.js',
  './app.webmanifest', './icon-192.png', './icon-512.png',
  './vendor/leaflet.js', './vendor/leaflet.css', './vendor/daisyui.css',
  '../assets/doto.ttf', '../assets/karakoram.webp'
].map(function (path) { return new URL(path, self.registration.scope).href; });

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(cacheName).then(function (cache) { return cache.addAll(assets); }));
});
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (name) { return name !== cacheName && name.indexOf('motr-iphone-shell-') === 0; })
      .map(function (name) { return caches.delete(name); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === 'navigate' && new URL(request.url).pathname.indexOf(new URL(self.registration.scope).pathname) === 0) {
    event.respondWith(fetch(request).catch(function () { return caches.match(assets[0]); }));
  } else if (assets.indexOf(request.url) !== -1) {
    event.respondWith(fetch(request).then(function (response) {
      if (response.ok) {
        var copy = response.clone();
        event.waitUntil(caches.open(cacheName).then(function (cache) { return cache.put(request, copy); }).catch(function () {}));
      }
      return response;
    }).catch(function () { return caches.match(request); }));
  }
});
