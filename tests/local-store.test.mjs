import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalStore, LocalStoreError} from '../src/local-store.mjs';
import {applySync, createEmptySpace} from '../sync/protocol.mjs';

// A transaction model with a shared lock and atomic commits. Browser checks additionally
// exercise the real IndexedDB implementation; these tests inject failures deterministically.
function memoryIndexedDB() {
  const documents = new Map(), names = new Set();
  let tail = Promise.resolve(), failCommit;
  const database = {
    objectStoreNames:{contains:name => names.has(name)},
    createObjectStore(name) {names.add(name);}, close() {},
    transaction(name, mode) {
      if (!names.has(name)) throw new Error('missing object store');
      const tx = {error:null, oncomplete:null, onabort:null, onerror:null};
      let live = false, finished = false, scheduled = false, pending = 0, data;
      const work = [], previous = tail;
      let release;
      tail = new Promise(resolve => {release = resolve;});
      const completeLater = () => {
        if (scheduled || finished) return;
        scheduled = true;
        setImmediate(() => {
          scheduled = false;
          if (finished || !live || pending) return;
          if (mode === 'readwrite' && failCommit) {tx.error = failCommit; failCommit = undefined; tx.abort(); return;}
          if (mode === 'readwrite') {documents.clear(); for (const [key, value] of data) documents.set(key, structuredClone(value));}
          finished = true;
          tx.oncomplete?.(); release();
        });
      };
      const run = job => setImmediate(() => {
        if (finished) return;
        try {job.request.result = job.callback(); job.request.onsuccess?.();}
        catch (error) {job.request.error = error; job.request.onerror?.(); tx.error = error; tx.abort();}
        pending--; completeLater();
      });
      const request = callback => {
        if (finished) throw new Error('inactive transaction');
        const request = {onsuccess:null, onerror:null, result:undefined};
        pending++;
        const job = {request, callback};
        if (live) run(job); else work.push(job);
        return request;
      };
      tx.objectStore = () => ({
        get:key => request(() => structuredClone(data.get(key))),
        put:(value, key) => request(() => {
          if (mode !== 'readwrite') throw new Error('readonly transaction');
          data.set(key, structuredClone(value)); return key;
        }),
      });
      tx.abort = () => {
        if (finished) throw new Error('already finished');
        finished = true;
        queueMicrotask(() => {tx.onabort?.(); release();});
      };
      previous.then(() => {
        if (finished) return;
        live = true; data = new Map([...documents].map(([key, value]) => [key, structuredClone(value)]));
        work.forEach(run); completeLater();
      });
      return tx;
    },
  };
  return {
    open() {
      const request = {result:database};
      queueMicrotask(() => {if (!names.size) request.onupgradeneeded?.(); request.onsuccess?.();});
      return request;
    },
    failNextCommit(error = Object.assign(new Error('full'), {name:'QuotaExceededError'})) {failCommit = error;},
  };
}

function fixture() {
  const indexedDB = memoryIndexedDB();
  let count = 0, time = 1800000000000;
  const makeId = () => '00000000-0000-4000-8000-' + (++count).toString(16).padStart(12, '0');
  const options = {indexedDB, makeId, now:() => time};
  return {indexedDB, options, makeId, store:createLocalStore(options), tick:amount => {time += amount;}};
}

test('graded local answers survive reopening and new backup import without changing review dates',async()=>{
  const f=fixture();await f.store.initialize();const first=await f.store.putWord({korean:'사과',chinese:'苹果'}),word=first.words[0];
  const payload={id:f.makeId(),wordId:word.id,generation:word.generation,direction:'zh',correct:true,retry:false,rating:'hard',phase:'quiz'};
  await f.store.answer(payload);await f.store.answer(payload);
  await assert.rejects(f.store.answer({...payload,rating:'good'}),/已保存/);
  const before=await f.store.read();assert.equal(before.words[0].mistakes,0);
  f.store.close();f.store=createLocalStore(f.options);assert.deepEqual((await f.store.read()).words,before.words);
  const backup=await f.store.exportBackup(),other=fixture();await other.store.initialize();const imported=await other.store.importBackup(backup);
  assert.equal(imported.words[0].reviewAt,before.words[0].reviewAt);assert.deepEqual(imported.words[0].reviewProgress,before.words[0].reviewProgress);
});

test('device words and learning progress survive closing and reopening without a server', async () => {
  const f = fixture(), initial = await f.store.initialize();
  assert.equal(initial.isNew, true); assert.match(initial.code, /^SC-/); assert.equal(initial.cloudConfigured, false);
  const added = await f.store.putWord({korean:'학교', chinese:'学校'}), word = added.words[0];
  await f.store.answer({id:f.makeId(), wordId:word.id, direction:'ko', correct:true, retry:false});
  await f.store.answer({id:f.makeId(), wordId:word.id, direction:'zh', correct:true, retry:false});
  await f.store.close();
  const reopened = createLocalStore(f.options), state = await reopened.initialize();
  assert.equal(state.isNew, false); assert.equal(state.code, initial.code);
  assert.equal(state.words[0].masteryKo, 1); assert.equal(state.words[0].masteryZh, 1);
  assert.equal(state.words[0].reviewDays, 1); assert.equal(state.pending.length, 3);
});

test('concurrent tabs allocate unique ordered sequences and do not lose another tab answer', async () => {
  const f = fixture(); await f.store.initialize();
  const second = createLocalStore(f.options); await second.initialize();
  const word = (await f.store.putWord({korean:'친구', chinese:'朋友'})).words[0];
  await Promise.all(Array.from({length:12}, (_, index) => (index % 2 ? second : f.store).answer({id:f.makeId(), wordId:word.id, direction:index % 2 ? 'ko' : 'zh', correct:false, retry:false})));
  const state = await second.read();
  assert.equal(state.words[0].mistakes, 12);
  assert.deepEqual(state.pending.map(operation => operation.seq), Array.from({length:13}, (_, index) => index + 1));
  assert.equal(new Set(state.pending.map(operation => operation.id)).size, 13);
});

test('failed storage commit rejects the save and leaves previously committed state intact', async () => {
  const f = fixture(); await f.store.initialize();
  const word = (await f.store.putWord({korean:'봄', chinese:'春天'})).words[0];
  f.indexedDB.failNextCommit();
  await assert.rejects(f.store.answer({id:f.makeId(), wordId:word.id, direction:'ko', correct:false, retry:false}), /尚未保存/);
  const after = await f.store.read();
  assert.equal(after.words[0].mistakes, 0); assert.equal(after.pending.length, 1);
  const reopened = createLocalStore(f.options); assert.equal((await reopened.initialize()).words[0].korean, '봄');
});

test('acknowledgement removes only submitted operations while retaining newer local answers', async () => {
  const f = fixture(); await f.store.initialize();
  const word = (await f.store.putWord({korean:'사과', chinese:'苹果', recording:{url:'https://dicmedia.korean.go.kr/multimedia/apple.wav'}})).words[0];
  const batch = await f.store.pendingBatch();
  const server = applySync(createEmptySpace('remote-space', f.options.now()), batch, {now:f.options.now()});
  const answerId = f.makeId();
  await f.store.answer({id:answerId, wordId:word.id, direction:'ko', correct:true, retry:false});
  const after = await f.store.applyRemote(server.response, {code:batch.code});
  assert.equal(after.pending.length, 1); assert.equal(after.pending[0].seq, 2);
  assert.equal(after.words[0].masteryKo, 1); assert.ok(after.words[0].recording);
  await f.store.answer({id:answerId, wordId:word.id, direction:'ko', correct:true, retry:false});
  assert.equal((await f.store.read()).pending.length, 1);
  const answerBatch = await f.store.pendingBatch();
  const final = applySync(server.state, answerBatch, {now:f.options.now()});
  await f.store.applyRemote(final.response);
  await f.store.answer({id:answerId, wordId:word.id, direction:'ko', correct:true, retry:false});
  assert.equal((await f.store.read()).pending.length, 0);
});

test('space switching retains each space queue and an in-flight reply is applied to its original code', async () => {
  const f = fixture(), first = await f.store.initialize();
  await f.store.putWord({korean:'물', chinese:'水'});
  const firstBatch = await f.store.pendingBatch();
  const secondCode = 'SC-' + f.makeId();
  await f.store.setSpace(secondCode, {allowCreate:true});
  await f.store.putWord({korean:'꽃', chinese:'花'});
  const remote = applySync(createEmptySpace('first-remote', f.options.now()), firstBatch, {now:f.options.now()});
  await f.store.applyRemote(remote.response, {code:first.code});
  assert.equal((await f.store.read()).code, secondCode);
  assert.equal((await f.store.read()).words[0].korean, '꽃');
  assert.equal((await f.store.read()).pending.length, 1);
  assert.equal((await f.store.setSpace(first.code)).pending.length, 0);
  await assert.rejects(f.store.setSpace('SC-' + f.makeId()), /联网恢复/);
});

test('stale remote replies never undo a newer snapshot or its acknowledgements', async () => {
  const f = fixture(); await f.store.initialize();
  const word = (await f.store.putWord({korean:'하늘', chinese:'天空'})).words[0];
  const first = applySync(createEmptySpace('remote-space', f.options.now()), await f.store.pendingBatch(), {now:f.options.now()});
  await f.store.applyRemote(first.response);
  await f.store.answer({id:f.makeId(), wordId:word.id, direction:'ko', correct:false, retry:false});
  const second = applySync(first.state, await f.store.pendingBatch(), {now:f.options.now()});
  await f.store.applyRemote(second.response); await f.store.applyRemote(first.response);
  const state = await f.store.read();
  assert.equal(state.words[0].mistakes, 1); assert.equal(state.pending.length, 0); assert.equal(state.revision, second.response.revision);
});

test('conflicting cloud edits preserve the rejected local meaning for recovery', async () => {
  const f = fixture(); await f.store.initialize();
  const word = (await f.store.putWord({korean:'사과', chinese:'苹果'})).words[0];
  const first = applySync(createEmptySpace('remote-space', f.options.now()), await f.store.pendingBatch(), {now:f.options.now()});
  await f.store.applyRemote(first.response);
  const otherClient = f.makeId(), otherGeneration = f.makeId();
  const other = applySync(first.state, {code:(await f.store.read()).code, clientId:otherClient, operations:[{id:f.makeId(), clientId:otherClient, seq:1, createdAt:f.options.now(), type:'word-put', payload:{word:{...word, chinese:'道歉', generation:otherGeneration}, baseGeneration:word.generation}}]}, {now:f.options.now()});
  await f.store.putWord({korean:'사과', chinese:'水果'}, word.id);
  const conflict = applySync(other.state, await f.store.pendingBatch(), {now:f.options.now()});
  const result = await f.store.applyRemote(conflict.response);
  assert.equal(result.pending.length, 0); assert.equal(result.words[0].chinese, '道歉');
  assert.equal(result.conflicts[0].reason, 'generation-changed');
  assert.equal(result.conflicts[0].localOperation.payload.word.chinese, '水果');
  assert.equal((await f.store.exportBackup()).conflicts[0].localOperation.payload.word.chinese, '水果');
});

test('legacy import preserves review intervals, mistakes and official recording metadata', async () => {
  const f = fixture(); await f.store.initialize();
  const code = 'SC-' + f.makeId(), wordId = f.makeId();
  const imported = await f.store.importLegacy({code, spaceId:'legacy-space', words:[{id:wordId, korean:'안녕', chinese:'你好', createdAt:f.options.now()-100000, masteryKo:1, masteryZh:1, mistakes:7, lastPracticedAt:f.options.now()-1000, reviewDays:7, reviewAt:f.options.now()-1000+7*86400000, recording:{url:'https://dicmedia.korean.go.kr/multimedia/hello.wav'}}]});
  assert.equal(imported.words[0].mistakes, 7); assert.equal(imported.words[0].reviewDays, 7);
  assert.equal(imported.words[0].reviewProgress.cleanRounds, 3); assert.ok(imported.words[0].recording);
  const again = await f.store.importLegacy({code, spaceId:'legacy-space', words:[]});
  assert.equal(again.words.length, 1); assert.equal(again.pending.length, 1);
});

test('no IndexedDB support reports an error instead of creating transient personal data', async () => {
  await assert.rejects(createLocalStore({indexedDB:null}).initialize(), error => error instanceof LocalStoreError && /不支持保存/.test(error.message));
});

test('sync endpoint configuration persists and rejects nonsecure external hosts', async () => {
  const f = fixture(); await f.store.initialize();
  await assert.rejects(f.store.configureCloud('http://example.com/api/sync'), /HTTPS/);
  await f.store.configureCloud('/api/sync'); await f.store.close();
  const reopened = createLocalStore(f.options); await reopened.initialize();
  assert.equal(await reopened.cloudEndpoint(), '/api/sync'); assert.equal((await reopened.read()).cloudConfigured, true);
});

test('backup import appends only new Korean words and preserves their learning progress', async () => {
  const f = fixture(); await f.store.initialize();
  await f.store.putWord({korean:'학교', chinese:'学校'});
  const original = (await f.store.read()).words[0];
  const imported = await f.store.importBackup({schemaVersion:1, words:[
    {...original, chinese:'校舍', masteryKo:1, masteryZh:1},
    {id:original.id, korean:'친구', chinese:'朋友', createdAt:f.options.now()-100000, masteryKo:1, masteryZh:1, mistakes:5, lastPracticedAt:f.options.now()-1000, reviewDays:7, recording:{url:'https://dicmedia.korean.go.kr/multimedia/friend.wav'}},
    {korean:'친구', chinese:'好友'},
  ]});
  assert.equal(imported.added, 1); assert.equal(imported.skipped, 2);
  assert.equal(imported.words.find(word => word.korean === '학교').chinese, '学校');
  const friend = imported.words.find(word => word.korean === '친구');
  assert.notEqual(friend.id, original.id); assert.equal(friend.mistakes, 5); assert.equal(friend.reviewDays, 7); assert.ok(friend.recording);
  const exported = await f.store.exportBackup();
  const secondCode = 'SC-' + f.makeId(); await f.store.setSpace(secondCode, {allowCreate:true});
  const restored = await f.store.importBackup(exported);
  assert.equal(restored.added, 2); assert.equal(restored.words.find(word => word.korean === '친구').masteryZh, 1);
});

test('one invalid backup row rolls back the entire import without modifying the word library', async () => {
  const f = fixture(); await f.store.initialize(); await f.store.putWord({korean:'물', chinese:'水'});
  await assert.rejects(f.store.importBackup({version:1, words:[
    {korean:'바다', chinese:'海'},
    {korean:'꽃', chinese:'花', masteryKo:100, mistakes:5},
  ]}), /学习进度/);
  const state = await f.store.read(); assert.equal(state.words.length, 1); assert.equal(state.pending.length, 1);
});

test('an old question cannot change a word that another tab edited or deleted', async () => {
  const f = fixture(); await f.store.initialize();
  const second = createLocalStore(f.options); await second.initialize();
  const old = (await f.store.putWord({korean:'사과', chinese:'苹果'})).words[0];
  await second.putWord({korean:'사과', chinese:'道歉'}, old.id);
  await assert.rejects(f.store.answer({id:f.makeId(), wordId:old.id, generation:old.generation, direction:'ko', correct:true, retry:false}), error => error.status === 409 && error.code === 'WORD_CHANGED' && /释义已经修改/.test(error.message));
  assert.equal((await f.store.read()).words[0].masteryKo, 0);
  await second.deleteWord(old.id);
  await assert.rejects(f.store.answer({id:f.makeId(), wordId:old.id, generation:old.generation, direction:'ko', correct:true, retry:false}), error => error.status === 404 && error.code === 'WORD_DELETED' && /已经被删除/.test(error.message));
  assert.equal((await f.store.read()).words.length, 0);
});

test('an offline queue longer than one network batch stays readable and retains all results', async () => {
  const f = fixture(); await f.store.initialize();
  const word = (await f.store.putWord({korean:'비', chinese:'雨'})).words[0];
  for (let index = 0; index < 110; index++) await f.store.answer({id:f.makeId(), wordId:word.id, direction:index % 2 ? 'ko' : 'zh', correct:false, retry:false});
  const state = await f.store.read(); assert.equal(state.words[0].mistakes, 110); assert.equal(state.pending.length, 111);
  const batch = await f.store.pendingBatch(); assert.equal(batch.operations.length, 100);
});

test('long local use compacts answer history and later cloud configuration seeds complete current progress', async () => {
  const f = fixture(); await f.store.initialize();
  const word = (await f.store.putWord({korean:'봄', chinese:'春天'})).words[0];
  const removed = (await f.store.putWord({korean:'가을', chinese:'秋天'})).words.find(item => item.korean === '가을');
  await f.store.deleteWord(removed.id);
  for (let index = 0; index < 205; index++) await f.store.answer({id:f.makeId(), wordId:word.id, generation:word.generation, direction:index % 2 ? 'ko' : 'zh', correct:false, retry:false});
  const local = await f.store.read();
  assert.equal(local.words.length, 1); assert.equal(local.words[0].mistakes, 205);
  assert.ok(local.pending.length < 10);
  await assert.rejects(f.store.answer({id:f.makeId(), wordId:removed.id, generation:removed.generation, direction:'ko', correct:true, retry:false}), /已经被删除/);
  const readded = await f.store.putWord({korean:'가을', chinese:'秋天'});
  assert.notEqual(readded.words.find(item => item.korean === '가을').id, removed.id);
  await f.store.close();
  const reopened = createLocalStore(f.options); assert.equal((await reopened.initialize()).words.find(item => item.id === word.id).mistakes, 205);
  await reopened.configureCloud('/api/sync');
  const batch = await reopened.pendingBatch();
  assert.equal(batch.operations.length, 1); assert.equal(batch.operations[0].type, 'space-import'); assert.equal(batch.operations[0].seq, 1);
  const server = applySync(createEmptySpace('new-cloud', f.options.now()), batch, {now:f.options.now()});
  assert.equal(server.response.words.find(item => item.id === word.id).mistakes, 205);
  const synced = await reopened.applyRemote(server.response);
  assert.equal(synced.pending.length, 0); assert.equal(synced.words.length, 2);
});

test('reaching the library limit rejects a new word without claiming it was saved', async () => {
  const f = fixture(); await f.store.initialize();
  await f.store.importBackup({version:1, words:Array.from({length:1000}, (_, index) => ({korean:'단어' + index, chinese:'词义' + index}))});
  await assert.rejects(f.store.putWord({korean:'끝', chinese:'结束'}), /最多可保存 1000/);
  const state = await f.store.read(); assert.equal(state.words.length, 1000); assert.equal(state.words.some(word => word.korean === '끝'), false);
});

test('stale word edits expose a recoverable conflict and preserve another tab meaning', async () => {
  const f = fixture(); await f.store.initialize();
  const second = createLocalStore(f.options); await second.initialize();
  const original = (await f.store.putWord({korean:'사과', chinese:'苹果'})).words[0];
  await second.putWord({korean:'사과', chinese:'道歉', generation:original.generation}, original.id);
  await assert.rejects(f.store.putWord({korean:'사과', chinese:'水果', generation:original.generation}, original.id), error => error.status === 409 && error.code === 'WORD_CHANGED');
  assert.equal((await f.store.read()).words[0].chinese, '道歉');
  await second.deleteWord(original.id);
  await assert.rejects(f.store.putWord({korean:'사과', chinese:'水果', generation:original.generation}, original.id), error => error.status === 404 && error.code === 'WORD_DELETED');
  assert.equal((await f.store.read()).words.length, 0);
});

test('reusing an answer ID with another result exposes a recoverable conflict', async () => {
  const f = fixture(); await f.store.initialize();
  const word = (await f.store.putWord({korean:'물', chinese:'水'})).words[0];
  const payload = {id:f.makeId(), wordId:word.id, generation:word.generation, direction:'ko', correct:true, retry:false};
  await f.store.answer(payload);
  await assert.rejects(f.store.answer({...payload, correct:false}), error => error.status === 409 && error.code === 'ANSWER_CONFLICT');
  const state = await f.store.read(); assert.equal(state.words[0].masteryKo, 1); assert.equal(state.words[0].mistakes, 0); assert.equal(state.pending.length, 2);
});
