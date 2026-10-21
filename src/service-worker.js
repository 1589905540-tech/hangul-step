// The build fingerprints the complete release and each installed resource.
const VERSION = 'offline-v1-__ASSET_VERSION__';
const ASSET_HASHES = /*__ASSET_HASHES__*/ {};
const APP_PREFIX = 'spring-app-';
const SHELL_CACHE = APP_PREFIX + VERSION;
const STATIC_PATHS = [
  '/', '/styles.css', '/app.mjs', '/core.mjs', '/dictionary.mjs', '/examples.mjs',
  '/pronunciation.mjs', '/recorded-audio.mjs', '/word-audio.mjs', '/local-store.mjs', '/sync/protocol.mjs',
  '/offline-lookup.mjs', '/lookup-ranking.mjs', '/app-config.json', '/icon.svg', '/coast-v1.webp',
  '/coast-ipad-v2.webp',
  '/chun-icon-180.png', '/chun-icon-192.png', '/chun-icon-512.png',
  '/manifest.webmanifest', '/dictionary-license', '/krdict-ko-zh-202609.json',
  '/krdict-lookup-priority.json',
  '/krdict-source.json', '/krdict-pronunciation-source.json'
];
const allowedPaths = new Set(STATIC_PATHS);
let cachePreparation;

function navigationSafeResponse(response) {
  if (!response.redirected) return response;
  // A host can redirect '/' to '/index.html'. A navigation response from Cache
  // Storage must not retain the followed redirect metadata on Safari.
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(response.body, {status:response.status, statusText:response.statusText, headers});
}

function cacheable(response) {
  return response?.status === 200 && !/no-store/i.test(response.headers.get('cache-control') || '');
}

async function matchesHash(response, expected) {
  if (!cacheable(response)) return false;
  const bytes = await response.clone().arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') === expected;
}

async function versionedResource(path) {
  // Unchanged files retain the same CDN URL across app updates.
  const resourceVersion = ASSET_HASHES[path] || VERSION;
  const url = new URL(path, self.location.origin);
  url.searchParams.set('__spring_version', resourceVersion);
  let response = await fetch(new Request(url.href, {cache:'reload', credentials:'omit'}));
  if (response.redirected) {
    const final = new URL(response.url);
    if (final.origin !== self.location.origin) throw new Error('Unexpected resource redirect: ' + path);
    if (final.searchParams.get('__spring_version') !== resourceVersion) {
      final.searchParams.set('__spring_version', resourceVersion);
      response = await fetch(new Request(final.href, {cache:'reload', credentials:'omit'}));
      if (response.redirected && new URL(response.url).origin !== self.location.origin) throw new Error('Unexpected resource redirect: ' + path);
    }
  }
  return response;
}

async function installResource(path, destination, savedCaches) {
  const expected = ASSET_HASHES[path];
  if (expected) {
    // Digest bodies instead of trusting version metadata. This also migrates
    // existing releases that predate per-file hashes without downloading again.
    for (const cache of savedCaches) {
      const saved = await cache.match(path);
      try {
        if (saved && await matchesHash(saved, expected)) {
          if (cache !== destination) await destination.put(path, navigationSafeResponse(saved));
          return;
        }
      } catch {
        // A damaged old entry must not prevent a fresh verified download.
      }
    }
  }
  const response = await versionedResource(path);
  if (!cacheable(response)) throw new Error('Offline resource unavailable: ' + path);
  if (expected && !await matchesHash(response, expected)) throw new Error('Offline resource integrity mismatch: ' + path);
  await destination.put(path, navigationSafeResponse(response));
}

function prepareResources() {
  if (cachePreparation) return cachePreparation;
  cachePreparation = (async () => {
    const destination = await caches.open(SHELL_CACHE);
    const oldNames = (await caches.keys()).filter(name => name.startsWith(APP_PREFIX) && name !== SHELL_CACHE).reverse();
    const savedCaches = [destination, ...await Promise.all(oldNames.map(name => caches.open(name)))];
    const results = await Promise.allSettled(STATIC_PATHS.map(path => installResource(path, destination, savedCaches)));
    const failure = results.find(result => result.status === 'rejected');
    // Keep verified partial entries for a retry. Until all resources succeed,
    // the old worker stays active and only reads its own complete shell.
    if (failure) throw failure.reason;
  })().finally(() => {cachePreparation = null;});
  return cachePreparation;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await prepareResources();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(APP_PREFIX) && key !== SHELL_CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const type = event.data?.type;
  if (!['SPRING_OFFLINE_STATUS', 'SPRING_PREPARE_OFFLINE'].includes(type) || !event.ports?.[0]) return;
  event.waitUntil((async () => {
    let error;
    // Only this explicit preparation message may repair missing resources over
    // the network. Normal status requests and app operations stay cache-only.
    if (type === 'SPRING_PREPARE_OFFLINE') {
      try {await prepareResources();} catch (failure) {error = String(failure?.message || failure);}
    }
    try {
      const cache = await caches.open(SHELL_CACHE);
      const missing = (await Promise.all(STATIC_PATHS.map(async path => cacheable(await cache.match(path)) ? null : path))).filter(Boolean);
      event.ports[0].postMessage({type:'SPRING_OFFLINE_STATUS', version:VERSION, ready:!error && missing.length === 0, missing, ...(error ? {error} : {})});
    } catch (failure) {
      event.ports[0].postMessage({type:'SPRING_OFFLINE_STATUS', version:VERSION, ready:false, missing:STATIC_PATHS, error:String(failure?.message || failure)});
    }
  })());
});

function offlineResponse() {
  return new Response('本地模式：此资源尚未下载，请在更新网站时重新准备离线资源。', {status:503, headers:{'Content-Type':'text/plain; charset=utf-8', 'Cache-Control':'no-store'}});
}

async function navigation() {
  const saved = await (await caches.open(SHELL_CACHE)).match('/');
  return saved ? navigationSafeResponse(saved) : offlineResponse();
}

async function staticAsset(pathname) {
  // Normal use never refreshes a resource behind the installed version's back.
  return await (await caches.open(SHELL_CACHE)).match(pathname) || offlineResponse();
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    event.respondWith(offlineResponse());
    return;
  }
  if (request.method !== 'GET') {
    event.respondWith(offlineResponse());
    return;
  }
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    event.respondWith(navigation());
    return;
  }
  if (allowedPaths.has(url.pathname)) {
    event.respondWith(staticAsset(url.pathname));
    return;
  }
  if (url.pathname === '/favicon.ico') {
    event.respondWith(new Response(null, {status:404}));
    return;
  }
  event.respondWith(offlineResponse());
});
