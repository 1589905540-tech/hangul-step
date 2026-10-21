import test from 'node:test';
import assert from 'node:assert/strict';
import {createOfflineLookup} from '../src/offline-lookup.mjs';

function fixture() {
  const paths=[];
  const dictionary={'친구':['朋友'], '낮':['白天'], '날':['日，天']};
  const lookup=createOfflineLookup({includeRecordings:false,fetcher:async path=>{
    paths.push(path);
    assert.ok(!path.includes('pronunciation'), 'Local speech must not load the recording URL index');
    return {ok:true,json:async()=>path.includes('priority')?{schemaVersion:1,entries:{}}:dictionary};
  }});
  return {lookup,paths};
}

test('local Korean and Chinese lookup keep meanings without loading recording links',async()=>{
  const {lookup,paths}=fixture();
  assert.equal((await lookup.lookup('친구')).chinese,'朋友');
  const daytime=await lookup.lookup('白天');
  assert.equal(daytime.korean,'낮');
  assert.equal(daytime.recording,null);
  assert.deepEqual(await lookup.meanings('낮'),['白天']);
  assert.equal(paths.length,2, 'The dictionary and optional ranking table are each read once');
});

test('adding or editing a local word never needs recording metadata',async()=>{
  const {lookup,paths}=fixture();
  assert.equal(await lookup.recording('친구','朋友'),null);
  assert.equal(await lookup.recording('새로운단어','手动填写'),null);
  assert.equal(paths.length,0);
});

test('an unlisted word stays a local miss and never falls back to an online translation service',async()=>{
  const {lookup,paths}=fixture();
  await assert.rejects(lookup.lookup('새로운단어'),error=>error.status===422);
  assert.deepEqual(paths,['/krdict-ko-zh-202609.json']);
});
