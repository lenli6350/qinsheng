"use strict";
/* sw.js — Service Worker：应用外壳可离线，接口请求不拦截
   策略：同源 GET 走"网络优先、失败回缓存"（保证每次部署后自动拿到新版本，
   断网时退回上次缓存的外壳）；跨域请求（大模型/ElevenLabs 等）完全不经过缓存。 */

var CACHE = "qinsheng-v1";

var SHELL = [
  "./",
  "index.html",
  "css/style.css",
  "js/persona.js",
  "js/llm.js",
  "js/tts.js",
  "js/app.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return; // API 调用直连网络

  e.respondWith(
    fetch(req)
      .then(function (resp) {
        if (resp && resp.ok) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return resp;
      })
      .catch(function () {
        return caches.match(req, { ignoreSearch: true }).then(function (m) {
          if (m) return m;
          if (req.mode === "navigate") return caches.match("index.html");
          return Response.error();
        });
      })
  );
});
