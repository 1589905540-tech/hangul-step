import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalPreview} from '../scripts/preview-local.mjs';
import worker from '../dist/server/index.js';

const paths=['/','/app.mjs','/word-audio.mjs','/local-store.mjs','/sync/protocol.mjs','/offline-lookup.mjs','/service-worker.js','/manifest.webmanifest','/app-config.json','/dictionary-license','/krdict-source.json'];
test('the hosted device edition serves offline entry points without a database or login',async()=>{
  for(const path of paths){
    const response=await worker.fetch(new Request('https://test.invalid'+path),{});
    assert.equal(response.status,200,path);assert.equal(response.headers.get('set-cookie'),null,path);
    assert.ok(!/no-store/.test(response.headers.get('cache-control')||''),path);
  }
  const settings=await (await worker.fetch(new Request('https://test.invalid/app-config.json'),{})).json();
  assert.equal(settings.mode,'local');
});
test('the static edition loads its real browser module graph and exposes no personal API',async t=>{
  const server=createLocalPreview();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin='http://127.0.0.1:'+server.address().port;
  const seen=new Set();
  async function checkModule(url){
    if(seen.has(url))return;seen.add(url);
    const response=await fetch(url);assert.equal(response.status,200,url);assert.match(response.headers.get('content-type'),/javascript/);
    const source=await response.text();
    for(const match of source.matchAll(/\bimport\s+[^;]+?from\s+['"]([^'"]+)['"]/g))await checkModule(new URL(match[1],url).href);
  }
  await checkModule(origin+'/app.mjs');assert.ok(seen.has(origin+'/sync/protocol.mjs'));
  for(const path of paths)assert.equal((await fetch(origin+path)).status,200,path);
  const config=await (await fetch(origin+'/app-config.json')).json();assert.equal(config.legacyImport,false);
  assert.equal((await fetch(origin+'/api/words')).status,404);
  assert.equal((await fetch(origin+'/api/answers',{method:'POST',body:'{}'})).status,405);
});
