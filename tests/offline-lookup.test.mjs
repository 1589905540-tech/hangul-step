import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createServer} from 'node:http';
import {createOfflineLookup} from '../src/offline-lookup.mjs';

const [dictionary, recordings, priority, workerSource] = await Promise.all([
  readFile(new URL('../src/data/krdict-ko-zh-202609.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/data/krdict-pronunciation-links.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/data/krdict-lookup-priority.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/service-worker.js', import.meta.url), 'utf8')
]);
function dictionaryFixture() {
  const calls = [];
  const fetcher = async path => {
    calls.push(path);
    assert.ok(['/krdict-ko-zh-202609.json', '/krdict-pronunciation-links.json', '/krdict-lookup-priority.json'].includes(path), 'Only public app assets may be fetched');
    return {ok:true, json:async () => path.includes('pronunciation') ? recordings : path.includes('priority') ? priority : dictionary};
  };
  return {lookup:createOfflineLookup({fetcher}), calls};
}

test('offline dictionary searches Korean, Chinese, aliases and individual synonyms', async () => {
  const {lookup, calls} = dictionaryFixture();
  assert.equal((await lookup.lookup(' 학교 ')).chinese, '学校');
  assert.equal((await lookup.lookup('价值观')).korean, '가치관');
  assert.equal((await lookup.lookup('가치관')).chinese, '价值观');
  assert.equal((await lookup.lookup('妈妈')).korean, '어머니');
  const synonym = await lookup.lookup('责任心');
  assert.ok(synonym.korean === '책임감' || synonym.candidates?.some(candidate => candidate.korean === '책임감'));
  const verb = await lookup.lookup('가다');
  assert.ok(verb.candidates.length > 16);
  assert.ok(verb.candidates.some(candidate => candidate.chinese === '去世'));
  assert.equal(calls.filter(path => path.includes('ko-zh')).length, 1);
  assert.equal(calls.filter(path => path.includes('pronunciation')).length, 1);
  assert.equal(calls.filter(path => path.includes('priority')).length, 1);
});

test('Chinese lookup recommends the primary beginner sense and keeps other valid meanings and recordings', async () => {
  const {lookup} = dictionaryFixture();
  const daytime = await lookup.lookup('白天');
  assert.equal(daytime.korean, '낮');
  assert.equal(daytime.chinese, '白天，白日，日间');
  assert.equal(daytime.recording.entryId, '64497');
  assert.ok(daytime.candidates.some(candidate => candidate.korean === '날' && candidate.chinese === '白天'));
  const day = await lookup.lookup('一天');
  assert.equal(day.korean, '하루');
  assert.ok(day.candidates.some(candidate => candidate.korean === '일간'));
  assert.equal((await lookup.lookup('下午')).korean, '오후');
  assert.equal((await lookup.lookup('便宜')).korean, '싸다');
  assert.equal((await lookup.lookup('날')).chinese, dictionary['날'][0]);
});

test('missing or invalid priorities do not disable lookup and can recover on the next query', async () => {
  for (const failure of ['network', 'schema']) {
    let attempts = 0;
    const lookup = createOfflineLookup({fetcher:async path => {
      if (path.includes('priority')) {
        attempts++;
        if (attempts === 1 && failure === 'network') throw new Error('offline');
        return {ok:true, json:async () => attempts === 1 ? {schemaVersion:0, entries:[]} : priority};
      }
      return {ok:true, json:async () => path.includes('pronunciation') ? recordings : dictionary};
    }});
    assert.equal((await lookup.lookup('白天')).korean, '낮');
    assert.equal((await lookup.lookup('一天')).korean, '하루');
    assert.equal(attempts, 2);
  }
});

test('homonym meanings retain their own original recording and ambiguous meanings do not guess a reading', async () => {
  const {lookup} = dictionaryFixture();
  const apple = await lookup.lookup('사과');
  assert.equal(apple.candidates.find(candidate => candidate.chinese === '苹果').recording.entryId, '66371');
  assert.equal(apple.candidates.find(candidate => candidate.chinese === '道歉').recording.entryId, '15830');
  assert.equal((await lookup.recording('사과', '苹果（水果）')).entryId, '66371');
  assert.equal((await lookup.recording('눈', '雪花')).entryId, '20198');
  assert.equal(await lookup.recording('사과', '苹果，道歉'), null);
  assert.equal(await lookup.recording('사과', '赔礼'), null);
  assert.equal(await lookup.recording('새로운발음확인테스트', '发音验证'), null);
});

test('full senses are available separately without changing the chosen personal meaning',async()=>{
  const {lookup,calls}=dictionaryFixture();
  assert.ok((await lookup.meanings('사과')).includes('苹果'));assert.ok((await lookup.meanings('사과')).includes('道歉'));
  assert.ok((await lookup.meanings('가다')).length>16);assert.equal(calls.length,1);
  assert.deepEqual(await lookup.meanings('새로운테스트단어'),[]);
});
test('failed full-meaning reads can recover after connectivity returns',async()=>{
  let unavailable=true;const lookup=createOfflineLookup({fetcher:async()=>{if(unavailable)throw new Error('offline');return {ok:true,json:async()=>dictionary};}});
  assert.equal(await lookup.meanings('사과'),null);unavailable=false;assert.ok((await lookup.meanings('사과')).includes('道歉'));
});

test('Chinese query limit is disclosed and exact pair duplicates are removed', async () => {
  const data = Object.fromEntries(Array.from({length:45}, (_, index) => ['가' + String.fromCharCode(0xac00 + index), ['测试释义', '测试释义']]));
  const lookup = createOfflineLookup({fetcher:async path => ({ok:true, json:async () => path.includes('pronunciation') ? {} : data})});
  const result = await lookup.lookup('测试释义');
  assert.equal(result.candidates.length, 40);
  assert.equal(result.totalCandidates, 45);
  assert.equal(new Set(result.candidates.map(candidate => candidate.korean)).size, 40);
});

test('unrecorded words invite manual entry and never call an external translation service', async () => {
  const {lookup} = dictionaryFixture();
  await assert.rejects(lookup.lookup('새로운번역테스트단어'), error => error.status === 422 && /手动填写/.test(error.message));
  await assert.rejects(lookup.lookup('新的翻译测试用词'), error => error.status === 422);
  for (const input of ['', '朋友 친구', 'hello', '가'.repeat(81), null]) await assert.rejects(lookup.lookup(input), error => error.status === 400);
});

test('asset failures keep starter words usable, report preparation failure, and retry on the next query', async () => {
  let unavailable = true, requests = 0;
  const lookup = createOfflineLookup({fetcher:async path => {
    requests++;
    if (unavailable) throw new Error('offline');
    return {ok:true, json:async () => path.includes('pronunciation') ? recordings : dictionary};
  }});
  assert.equal((await lookup.lookup('친구')).chinese, '朋友');
  assert.equal((await lookup.lookup('친구')).recording, null);
  await assert.rejects(lookup.lookup('가치관'), error => error.status === 503 && /联网/.test(error.message));
  unavailable = false;
  assert.equal((await lookup.lookup('가치관')).chinese, '价值观');
  assert.equal((await lookup.lookup('친구')).recording.entryId, '29742');
  assert.ok(requests > 4);
});

function serviceWorkerFixture({version = 'fixture', origin = 'https://spring.invalid', fetcher = async () => new Response('public asset', {status:200}), storage = new Map()} = {}) {
  const listeners = new Map();
  const key = value => new URL(typeof value === 'string' ? value : value.url, origin).href;
  class BrowserRequest extends Request {constructor(value, init) {super(typeof value === 'string' ? new URL(value, origin) : value, init);}}
  const caches = {
    async open(name) {
      if (!storage.has(name)) storage.set(name, new Map());
      const data = storage.get(name);
      return {
        async match(request) {return data.get(key(request))?.clone();},
        async put(request, response) {data.set(key(request), response.clone());},
        async delete(request) {return data.delete(key(request));},
        async keys() {return [...data.keys()].map(url => new BrowserRequest(url));}
      };
    },
    async keys() {return [...storage.keys()];},
    async delete(name) {return storage.delete(name);}
  };
  let activated = false;
  const self = {location:{origin}, clients:{async claim() {}}, async skipWaiting() {activated = true;}, addEventListener(type, listener) {listeners.set(type, listener);}};
  vm.runInNewContext(workerSource.replace('__ASSET_VERSION__', version), {self, caches, fetch:fetcher, Request:BrowserRequest, Response, Headers, URL, console});
  async function run(type, request) {
    const waiting = []; let response;
    const event = {request, waitUntil(promise) {waiting.push(promise);}, respondWith(promise) {response = promise;}};
    listeners.get(type)(event);
    const result = response ? await response : undefined;
    await Promise.all(waiting);
    return result;
  }
  return {run, storage, caches, request:(url, init) => new BrowserRequest(url, init), activated:() => activated};
}

test('service worker installs a complete public shell and blocks API or unknown requests locally', async () => {
  const f = serviceWorkerFixture();
  await f.run('install');
  assert.equal(f.activated(), true);
  const shell = f.storage.get('spring-app-offline-v1-fixture');
  assert.ok(shell.has('https://spring.invalid/krdict-ko-zh-202609.json'));
  assert.ok(shell.has('https://spring.invalid/local-store.mjs'));
  assert.ok(shell.has('https://spring.invalid/lookup-ranking.mjs'));
  assert.ok(shell.has('https://spring.invalid/krdict-lookup-priority.json'));
  assert.equal((await f.run('fetch', f.request('/api/words'))).status, 503);
  assert.equal((await f.run('fetch', f.request('/api/session'))).status, 503);
  assert.equal((await f.run('fetch', f.request('/private.json'))).status, 503);
  assert.ok(shell.has('https://spring.invalid/sync/protocol.mjs'));
  assert.equal(await (await f.run('fetch', f.request('/icon.svg?v=sprout-2'))).text(), 'public asset');
  assert.equal(shell.has('https://spring.invalid/icon.svg?v=sprout-2'), false);
});

test('shell, dictionary and public configuration stay on their installed version without online refreshes', async () => {
  let online = true, configuration = 'original endpoint';
  const f = serviceWorkerFixture({fetcher:async request => {
    if (request.mode !== 'navigate') assert.equal(request.credentials, 'omit');
    if (!online) throw new Error('offline');
    return new Response(new URL(request.url).pathname === '/app-config.json' ? configuration : 'public asset', {status:200, headers:{'Cache-Control':'private, no-cache'}});
  }});
  await f.run('install');
  configuration = 'new endpoint';
  assert.equal(await (await f.run('fetch', f.request('/app-config.json'))).text(), 'original endpoint');
  online = false;
  const navigation = f.request('/');
  Object.defineProperty(navigation, 'mode', {value:'navigate'});
  // A navigation response is not cached; only the credential-free install is.
  assert.equal(await (await f.run('fetch', navigation)).text(), 'public asset');
  assert.equal(await (await f.run('fetch', f.request('/krdict-ko-zh-202609.json'))).text(), 'public asset');
  assert.equal(await (await f.run('fetch', f.request('/app-config.json'))).text(), 'original endpoint');
});

test('controlled navigation keeps HTML and modules on one version until a complete new worker activates', async () => {
  const storage = new Map();
  let deployment = 'A', requests = 0;
  const fetcher = async request => {
    requests++;
    const pathname = new URL(request.url).pathname;
    return new Response((pathname === '/' ? 'page-' : 'module-') + deployment, {status:200});
  };
  const previous = serviceWorkerFixture({version:'A', storage, fetcher});
  await previous.run('install');
  await previous.run('activate');
  const firstNavigation = previous.request('/');
  Object.defineProperty(firstNavigation, 'mode', {value:'navigate'});
  deployment = 'B';
  const beforeNavigation = requests;
  assert.equal(await (await previous.run('fetch', firstNavigation)).text(), 'page-A');
  assert.equal(await (await previous.run('fetch', previous.request('/app.mjs'))).text(), 'module-A');
  assert.equal(requests, beforeNavigation, 'New server HTML must not bypass the installed shell');
  const updated = serviceWorkerFixture({version:'B', storage, fetcher});
  await updated.run('install');
  await updated.run('activate');
  const nextNavigation = updated.request('/');
  Object.defineProperty(nextNavigation, 'mode', {value:'navigate'});
  assert.equal(await (await updated.run('fetch', nextNavigation)).text(), 'page-B');
  assert.equal(await (await updated.run('fetch', updated.request('/app.mjs'))).text(), 'module-B');
  assert.equal(storage.has('spring-app-offline-v1-A'), false);
});

test('a redirected static homepage reopens offline through root and index.html without redirect metadata', async t => {
  const server = createServer((request, response) => {
    if (new URL(request.url, 'http://fixture.invalid').pathname === '/') {response.writeHead(302, {Location:'/index.html'}); response.end(); return;}
    response.writeHead(200, {'Content-Type':'text/html'});
    response.end('<title>spring offline</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let online = true, redirects = 0, indexRequests = 0;
  const f = serviceWorkerFixture({origin, fetcher:async request => {
    if (!online) throw new Error('offline');
    const url = new URL(request.url);
    if (!['/', '/index.html'].includes(url.pathname)) return new Response('public asset');
    const response = await fetch(request);
    if (url.pathname === '/') {
      assert.equal(response.redirected, true, 'Fixture must reproduce a followed host redirect');
      assert.equal(new URL(response.url).searchParams.has('__spring_version'), false, 'The host redirect must drop the version query');
      redirects++;
    } else {
      assert.equal(url.searchParams.get('__spring_version'), 'offline-v1-fixture', 'The redirected entry must be fetched again with its version');
      indexRequests++;
    }
    return response;
  }});
  await f.run('install');
  assert.equal(redirects, 1);
  assert.equal(indexRequests, 1);
  online = false;
  for (const path of ['/', '/index.html', '/index.html?from=home-screen']) {
    const request = f.request(path, {redirect:'manual'});
    Object.defineProperty(request, 'mode', {value:'navigate'});
    const response = await f.run('fetch', request);
    assert.ok(response, 'The static-host entry URL must use the offline shell');
    assert.equal(response.redirected, false, 'Manual navigation cannot receive a followed redirect response');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html');
    assert.equal(await response.text(), '<title>spring offline</title>');
  }
});

test('failed shell installation retains the old working version and rejects no-store configuration', async () => {
  const storage = new Map([['spring-app-offline-v1-old', new Map()], ['other-application-cache', new Map()]]);
  const f = serviceWorkerFixture({storage, fetcher:async request => new Response('asset', {status:200, headers:{'Cache-Control':new URL(request.url).pathname === '/app-config.json' ? 'private, no-store' : 'public'}})});
  await assert.rejects(f.run('install'), /Offline resource unavailable/);
  assert.equal(f.activated(), false);
  assert.ok(storage.has('spring-app-offline-v1-old'));
  assert.ok(storage.has('other-application-cache'));
  assert.equal(storage.has('spring-app-offline-v1-fixture'), true, 'Partial downloaded entries are retained for a hash-verified retry');
});

test('activation removes only obsolete spring shell caches and keeps listened recordings', async () => {
  const storage = new Map([['spring-app-offline-v1-old', new Map()], ['spring-recordings-v1', new Map()], ['other-application-cache', new Map()]]);
  const f = serviceWorkerFixture({storage});
  await f.run('install');
  await f.run('activate');
  assert.equal(storage.has('spring-app-offline-v1-old'), false);
  assert.ok(storage.has('spring-app-offline-v1-fixture'));
  assert.ok(storage.has('spring-recordings-v1'));
  assert.ok(storage.has('other-application-cache'));
});

test('legacy original recording requests are blocked locally, including Range requests', async () => {
  const f = serviceWorkerFixture({fetcher:async () => assert.fail('Recording playback must not make a network request')});
  const url = 'https://dicmedia.korean.go.kr/multimedia/sound_file/test.wav';
  for (const headers of [{}, {Range:'bytes=2-4'}, {Range:'bytes=-3'}, {Range:'bytes=20-'}]) {
    const response = await f.run('fetch', f.request(url, {headers}));
    assert.equal(response.status, 503);
    assert.match(await response.text(), /本地模式/);
  }
  assert.equal(f.storage.has('spring-recordings-v1'), false);
});

test('external requests and personal API writes cannot escape local mode', async () => {
  const f = serviceWorkerFixture({fetcher:async () => assert.fail('Local mode must not access external services')});
  for (const request of [f.request('https://other.invalid/recording.wav'), f.request('https://other.invalid/translation', {method:'POST'}), f.request('/api/answers', {method:'POST'}), f.request('/api', {method:'DELETE'})]) {
    assert.equal((await f.run('fetch', request)).status, 503);
  }
});

test('a missing local entry fails locally while obsolete recordings are retained untouched', async () => {
  const url = 'https://dicmedia.korean.go.kr/multimedia/legacy.wav';
  const storage = new Map([['spring-recordings-v1', new Map([[url, new Response('legacy recording')]])]]);
  const f = serviceWorkerFixture({storage, fetcher:async () => assert.fail('A missing offline resource must not download silently')});
  assert.equal((await f.run('fetch', f.request('/krdict-ko-zh-202609.json'))).status, 503);
  assert.equal((await f.run('fetch', f.request(url))).status, 503);
  assert.equal(await (await (await f.caches.open('spring-recordings-v1')).match(url)).text(), 'legacy recording');
});
