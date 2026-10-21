import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import worker from '../dist/server/index.js';

const root=resolve(import.meta.dirname,'..');
const publicRoot=resolve(root,'dist/public');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const serviceWorker=await readFile(resolve(publicRoot,'service-worker.js'),'utf8');
const paths=[...serviceWorker.match(/const STATIC_PATHS\s*=\s*\[([\s\S]*?)\];/)[1].matchAll(/['"]([^'"]+)['"]/g)].map(match=>match[1]);
const hashes=JSON.parse(serviceWorker.match(/^const ASSET_HASHES = (\{[^\n]*\});$/m)[1]);

test('the offline worker fingerprints every real static asset byte',async()=>{
  assert.deepEqual(Object.keys(hashes).sort(),paths.toSorted());
  assert.ok(!serviceWorker.includes('__ASSET_HASHES__'));
  assert.ok(!serviceWorker.includes('__ASSET_VERSION__'));
  assert.ok(!paths.includes('/krdict-pronunciation-links.json'));
  for(const path of paths){
    const bytes=await readFile(resolve(publicRoot,path==='/'?'index.html':path.slice(1)));
    assert.match(hashes[path],/^[0-9a-f]{64}$/);
    assert.equal(digest(bytes),hashes[path],path);
  }
  await assert.rejects(access(resolve(publicRoot,'krdict-pronunciation-links.json')),{code:'ENOENT'});
});

test('the hosted worker serves the exact same bytes as its offline integrity map',async()=>{
  const hostedWorker=await (await worker.fetch(new Request('https://test.invalid/service-worker.js'),{})).text();
  assert.equal(hostedWorker,serviceWorker);
  for(const path of paths){
    const response=await worker.fetch(new Request('https://test.invalid'+path),{});
    assert.equal(response.status,200,path);
    assert.equal(digest(Buffer.from(await response.arrayBuffer())),hashes[path],path);
  }
});

test('dictionary JSON retains source bytes for reuse and hosted import stays disabled',async()=>{
  for(const name of ['krdict-ko-zh-202609.json','krdict-lookup-priority.json']){
    const original=await readFile(resolve(root,'src/data',name));
    assert.equal(digest(await readFile(resolve(publicRoot,name))),digest(original),name);
  }
  const config=await (await worker.fetch(new Request('https://test.invalid/app-config.json'),{})).json();
  assert.deepEqual(config,{mode:'local',legacyImport:false});
});
