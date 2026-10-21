import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash, webcrypto} from 'node:crypto';
import vm from 'node:vm';

const template = await readFile(new URL('../src/service-worker.js', import.meta.url), 'utf8');
const paths = [...template.match(/const STATIC_PATHS\s*=\s*\[([\s\S]*?)\];/)[1].matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
const origin = 'https://domestic.test';
const defaultVersion = 'test-local-update';
const digest = value => createHash('sha256').update(value).digest('hex');
const bodies = () => Object.fromEntries(paths.map(path => [path, 'fresh ' + path]));
const hashes = assets => Object.fromEntries(Object.entries(assets).map(([path, body]) => [path, digest(body)]));

function fixture({fetcher = request => new Response('fresh ' + new URL(request.url).pathname), assetHashes = {}, version = defaultVersion, stores = new Map()} = {}) {
  const handlers = new Map(), requests = [];
  let skips = 0, claims = 0;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {async put(path, response) {store.set(path, response.clone());}, async match(path) {return store.get(path)?.clone();}};
    },
    async delete(name) {return stores.delete(name);},
    async keys() {return [...stores.keys()];}
  };
  const self = {location:{origin}, addEventListener:(name, handler) => handlers.set(name, handler), skipWaiting:async () => {skips++;}, clients:{claim:async () => {claims++;}}};
  const source = template.replaceAll('__ASSET_VERSION__', version).replace('/*__ASSET_HASHES__*/ {}', JSON.stringify(assetHashes));
  vm.runInNewContext(source, {self, caches, URL, Request, Response, Headers, crypto:webcrypto, fetch:async request => {requests.push(request); return fetcher(request);}});
  return {
    stores, requests, skips:() => skips, claims:() => claims,
    async run(type, request) {
      let pending, result;
      handlers.get(type)({request, waitUntil:promise => {pending = promise;}, respondWith:response => {result = response;}});
      await pending;
      return result;
    },
    async install() {return this.run('install');},
    async activate() {return this.run('activate');},
    async status(type = 'SPRING_OFFLINE_STATUS') {
      let pending, result;
      handlers.get('message')({data:{type}, ports:[{postMessage:message => {result = message;}}], waitUntil:promise => {pending = promise;}});
      await pending;
      return result;
    },
    async request(path, {method = 'GET', navigate = false} = {}) {
      const request = new Request(new URL(path, origin), {method});
      if (navigate) Object.defineProperty(request, 'mode', {value:'navigate'});
      return this.run('fetch', request);
    }
  };
}

function oldStores() {return new Map([['spring-app-previous', new Map([['/', new Response('working older app')]])]]);}

 test('install bypasses stale CDN resources, including a root redirect that drops its query', async () => {
  const f = fixture({fetcher:request => {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      const stale = new Response('old CDN index');
      Object.defineProperties(stale, {redirected:{value:true}, url:{value:origin + '/index.html'}});
      return stale;
    }
    return new Response(url.searchParams.get('__spring_version') === 'offline-v1-' + defaultVersion ? 'fresh ' + url.pathname : 'old CDN content');
  }});
  await f.install();
  assert.equal(f.skips(), 1);
  assert.ok(f.requests.some(request => new URL(request.url).pathname === '/index.html'));
  for (const request of f.requests) {
    assert.equal(new URL(request.url).searchParams.get('__spring_version'), 'offline-v1-' + defaultVersion);
    assert.equal(request.credentials, 'omit');
  }
  const cache = f.stores.get('spring-app-offline-v1-' + defaultVersion);
  assert.equal(await cache.get('/').clone().text(), 'fresh /index.html');
  assert.ok([...cache.keys()].every(path => !path.includes('?')));
  assert.equal(await (await f.request('/', {navigate:true})).text(), 'fresh /index.html');
});

 test('an incomplete upload leaves the existing app available and keeps verified new entries for retry', async () => {
  const f = fixture({stores:oldStores(), fetcher:request => new URL(request.url).pathname === '/word-audio.mjs' ? new Response('missing', {status:404}) : new Response('new')});
  await assert.rejects(f.install(), /Offline resource unavailable/);
  assert.equal(f.skips(), 0);
  assert.equal(await f.stores.get('spring-app-previous').get('/').clone().text(), 'working older app');
  const partial = f.stores.get('spring-app-offline-v1-' + defaultVersion);
  assert.equal(partial.size, paths.length - 1);
  assert.equal(partial.has('/word-audio.mjs'), false);
});

 test('a login or cross-origin redirect cannot replace an offline app resource', async () => {
  const f = fixture({stores:oldStores(), fetcher:() => {
    const response = new Response('login');
    Object.defineProperties(response, {redirected:{value:true}, url:{value:'https://login.test/'}});
    return response;
  }});
  await assert.rejects(f.install(), /Unexpected resource redirect/);
  assert.equal(f.skips(), 0);
  assert.equal(await f.stores.get('spring-app-previous').get('/').clone().text(), 'working older app');
});

 test('reinstalling one release verifies local resources without downloading again', async () => {
  const assets = bodies(), stores = new Map(), assetHashes = hashes(assets);
  const first = fixture({stores, assetHashes});
  await first.install();
  assert.equal(first.requests.length, paths.length);
  const again = fixture({stores, assetHashes, fetcher:() => assert.fail('A verified local file must not be downloaded')});
  await again.install();
  assert.equal(again.requests.length, 0);
  assert.equal(again.skips(), 1);
});

 test('an update downloads only the changed module and switches the whole shell together', async () => {
  const oldAssets = bodies(), stores = new Map();
  const previous = fixture({version:'A', stores, assetHashes:hashes(oldAssets)});
  await previous.install();
  const newAssets = {...oldAssets, '/word-audio.mjs':'updated local pronunciation'};
  const current = fixture({version:'B', stores, assetHashes:hashes(newAssets), fetcher:request => new Response(newAssets[new URL(request.url).pathname])});
  await current.install();
  assert.deepEqual(current.requests.map(request => new URL(request.url).pathname), ['/word-audio.mjs']);
  assert.equal(new URL(current.requests[0].url).searchParams.get('__spring_version'), digest(newAssets['/word-audio.mjs']));
  assert.equal(await (await previous.request('/word-audio.mjs')).text(), oldAssets['/word-audio.mjs']);
  assert.equal(await (await current.request('/word-audio.mjs')).text(), newAssets['/word-audio.mjs']);
  assert.equal(await (await current.request('/krdict-ko-zh-202609.json')).text(), oldAssets['/krdict-ko-zh-202609.json']);
  await current.activate();
  assert.equal(stores.has('spring-app-offline-v1-A'), false);
  assert.equal(current.claims(), 1);
});

 test('the first hash-aware release reuses an old unversioned-content cache by digesting its bodies', async () => {
  const assets = bodies();
  const stores = new Map([['spring-app-unicloud-static-before-hashes', new Map(paths.map(path => [path, new Response(assets[path])]))], ['other-app', new Map()]]);
  const f = fixture({stores, assetHashes:hashes(assets), fetcher:() => assert.fail('Matching legacy bytes should be reused')});
  await f.install();
  assert.equal(f.requests.length, 0);
  assert.equal(f.stores.get('spring-app-offline-v1-' + defaultVersion).size, paths.length);
  await f.activate();
  assert.ok(stores.has('other-app'));
});

 test('a failed download retries only the missing entry while the old worker remains usable', async () => {
  const assets = bodies(), stores = oldStores(), assetHashes = hashes(assets);
  const broken = fixture({stores, assetHashes, fetcher:request => {
    const path = new URL(request.url).pathname;
    return path === '/krdict-lookup-priority.json' ? new Response('temporarily missing', {status:503}) : new Response(assets[path]);
  }});
  await assert.rejects(broken.install(), /Offline resource unavailable/);
  assert.equal(broken.skips(), 0);
  assert.equal(await stores.get('spring-app-previous').get('/').clone().text(), 'working older app');
  const retry = fixture({stores, assetHashes, fetcher:request => new Response(assets[new URL(request.url).pathname])});
  await retry.install();
  assert.deepEqual(retry.requests.map(request => new URL(request.url).pathname), ['/krdict-lookup-priority.json']);
});

 test('a stale CDN body is rejected even under the requested hash and never replaces the old shell', async () => {
  const assets = bodies(), stores = new Map();
  const previous = fixture({version:'A', stores, assetHashes:hashes(assets)});
  await previous.install();
  const updated = {...assets, '/word-audio.mjs':'new module bytes'};
  const stale = fixture({version:'B', stores, assetHashes:hashes(updated), fetcher:() => new Response(assets['/word-audio.mjs'])});
  await assert.rejects(stale.install(), /Offline resource integrity mismatch/);
  assert.equal(stale.skips(), 0);
  assert.equal(stores.get('spring-app-offline-v1-B').has('/word-audio.mjs'), false);
  assert.equal(await (await previous.request('/word-audio.mjs')).text(), assets['/word-audio.mjs']);
});

 test('corrupt cached bodies and no-store responses cannot pass integrity checks', async () => {
  const assets = bodies(), stores = new Map([['spring-app-old', new Map(paths.map(path => [path, new Response(path === '/app.mjs' ? 'corrupt bytes' : assets[path])]))]]);
  const f = fixture({stores, assetHashes:hashes(assets), fetcher:request => new Response(assets[new URL(request.url).pathname], {headers:{'Cache-Control':'no-store'}})});
  await assert.rejects(f.install(), /Offline resource unavailable/);
  assert.deepEqual(f.requests.map(request => new URL(request.url).pathname), ['/app.mjs']);
  assert.equal(f.skips(), 0);
});

 test('resource hashes survive a root redirect that removes its query', async () => {
  const assets = bodies(), assetHashes = hashes(assets);
  const f = fixture({assetHashes, fetcher:request => {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      const response = new Response('stale redirected index');
      Object.defineProperties(response, {redirected:{value:true}, url:{value:origin + '/index.html'}});
      return response;
    }
    if (url.pathname === '/index.html') {
      assert.equal(url.searchParams.get('__spring_version'), assetHashes['/']);
      return new Response(assets['/']);
    }
    return new Response(assets[url.pathname]);
  }});
  await f.install();
  assert.equal(await (await f.request('/index.html', {navigate:true})).text(), assets['/']);
});

 test('normal local use, configuration, blocked APIs and external recordings make no network requests', async () => {
  let online = true;
  const assets = bodies();
  const f = fixture({assetHashes:hashes(assets), fetcher:request => {
    assert.equal(online, true, 'Ordinary offline use must never call fetch');
    return new Response(assets[new URL(request.url).pathname]);
  }});
  await f.install();
  const before = f.requests.length;
  online = false;
  for (const path of paths) assert.equal((await f.request(path)).status, 200, path);
  assert.equal((await f.request('/index.html?from=home-screen', {navigate:true})).status, 200);
  for (const [path, method] of [['/api/words', 'GET'], ['/api/answers', 'POST'], ['/api', 'DELETE'], ['https://dicmedia.korean.go.kr/multimedia/test.wav', 'GET'], ['https://outside.test/service', 'POST'], ['/private.json', 'GET']]) {
    assert.equal((await f.request(path, {method})).status, 503, path);
  }
  assert.equal((await f.request('/favicon.ico')).status, 404);
  assert.equal(f.requests.length, before);
});

 test('a missing local file reports offline preparation instead of silently going online', async () => {
  const f = fixture({fetcher:() => assert.fail('A cache miss during use must not download')});
  assert.equal((await f.request('/app-config.json')).status, 503);
  assert.equal((await f.request('/', {navigate:true})).status, 503);
  assert.equal(f.requests.length, 0);
});

 test('offline status checks cached resources rather than treating an activated worker as ready', async () => {
  const assets = bodies();
  const f = fixture({assetHashes:hashes(assets)});
  const absent = await f.status();
  assert.equal(absent.ready, false);
  assert.equal(absent.missing.length, paths.length);
  await f.install();
  const before = f.requests.length;
  const ready = await f.status();
  assert.equal(ready.type, 'SPRING_OFFLINE_STATUS');
  assert.equal(ready.version, 'offline-v1-' + defaultVersion);
  assert.equal(ready.ready, true);
  assert.equal(ready.missing.length, 0);
  f.stores.get('spring-app-offline-v1-' + defaultVersion).delete('/krdict-ko-zh-202609.json');
  const evicted = await f.status();
  assert.equal(evicted.ready, false);
  assert.equal(evicted.missing.length, 1);
  assert.equal(evicted.missing[0], '/krdict-ko-zh-202609.json');
  assert.equal(f.requests.length, before);
});

 test('explicit offline preparation repairs only a missing file without changing the installed version', async () => {
  const assets = bodies();
  const f = fixture({assetHashes:hashes(assets)});
  await f.install();
  const before = f.requests.length;
  f.stores.get('spring-app-offline-v1-' + defaultVersion).delete('/krdict-ko-zh-202609.json');
  assert.equal((await f.request('/krdict-ko-zh-202609.json')).status, 503);
  assert.equal((await f.status()).ready, false);
  assert.equal(f.requests.length, before, 'Normal use and status must never repair over the network');
  const prepared = await f.status('SPRING_PREPARE_OFFLINE');
  assert.equal(prepared.ready, true);
  assert.equal(prepared.missing.length, 0);
  assert.equal(prepared.version, 'offline-v1-' + defaultVersion);
  assert.equal(f.requests.length, before + 1);
  assert.equal(new URL(f.requests.at(-1).url).pathname, '/krdict-ko-zh-202609.json');
  assert.equal(await (await f.request('/krdict-ko-zh-202609.json')).text(), assets['/krdict-ko-zh-202609.json']);
  assert.equal(f.skips(), 1, 'A repair must not call skipWaiting again');
  assert.equal(f.claims(), 0);
});

 test('explicit preparation reports an integrity failure without replacing existing cached files', async () => {
  const assets = bodies();
  let stale = false;
  const f = fixture({assetHashes:hashes(assets), fetcher:request => new Response(stale ? 'stale CDN body' : assets[new URL(request.url).pathname])});
  await f.install();
  f.stores.get('spring-app-offline-v1-' + defaultVersion).delete('/app.mjs');
  stale = true;
  const result = await f.status('SPRING_PREPARE_OFFLINE');
  assert.equal(result.ready, false);
  assert.match(result.error, /integrity mismatch/);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0], '/app.mjs');
  assert.equal(await (await f.request('/krdict-ko-zh-202609.json')).text(), assets['/krdict-ko-zh-202609.json']);
  assert.equal(f.skips(), 1);
});
