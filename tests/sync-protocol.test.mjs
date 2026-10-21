import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import * as protocol from '../sync/protocol.mjs';
import {reviewDetails} from '../worker/index.js';
const {createEmptySpace,applySync,publicSnapshot,projectSnapshot,compactReviewAnswer,validateSyncRequest,SYNC_LIMITS}=protocol;
const {createHandler}=createRequire(import.meta.url)('../unicloud/cloudfunctions/spring-sync/index.js');
const NOW=1720000000000,DAY=86400000;
const CODE='SC-'+randomUUID(),CLIENT=randomUUID(),OTHER=randomUUID();
const key=code=>createHash('sha256').update(protocol.normalizeLearningCode(code)).digest('hex');
const spaceId=code=>'SC-'+key(code).slice(0,24);
function makeWord(overrides={}) {return {id:randomUUID(),korean:'친구',chinese:'朋友',generation:randomUUID(),createdAt:NOW,...overrides};}
function operation(type,payload,{clientId=CLIENT,seq=1,createdAt=NOW,id=randomUUID()}={}) {return {type,payload,clientId,seq,createdAt,id};}
const put=(word,options={},baseGeneration=null)=>operation('word-put',{word,baseGeneration},options);
const answer=(word,correct=false,options={})=>operation('answer',{id:randomUUID(),wordId:word.id,generation:word.generation,direction:options.direction||'ko',correct,retry:options.retry||false},options);
const sync=(state,operations,clientId=CLIENT,now=NOW)=>applySync(state,{code:CODE,clientId,operations},{now});

test('sync validates secret learning codes, request size, operation sequence and normalized word pairs',()=>{
  assert.throws(()=>validateSyncRequest({code:'SC-1234',clientId:CLIENT}),/完整/);
  assert.throws(()=>validateSyncRequest({code:CODE,clientId:'device-1'}),/设备标识/);
  const word=makeWord({korean:'  친구  '.normalize('NFD'),chinese:'  好  朋友 '});
  const request=validateSyncRequest({code:CODE.toUpperCase(),clientId:CLIENT,operations:[put(word)]});
  assert.equal(request.code,CODE);assert.equal(request.operations[0].payload.word.korean,'친구');assert.equal(request.operations[0].payload.word.chinese,'好 朋友');
  assert.equal(validateSyncRequest({code:CODE,clientId:CLIENT}).operations.length,0);
  assert.throws(()=>validateSyncRequest({code:CODE,clientId:CLIENT,operations:[put(word),put(word)]}),/重复/);
  assert.throws(()=>validateSyncRequest({code:CODE,clientId:CLIENT,operations:[put(word,{clientId:OTHER})]}),/另一台设备/);
  assert.throws(()=>validateSyncRequest({code:CODE,clientId:CLIENT,create:'true'}),/参数/);
  assert.throws(()=>validateSyncRequest({code:CODE,clientId:CLIENT,extra:'x'.repeat(SYNC_LIMITS.requestBytes)}),/太多/);
});

test('permanent sequence acknowledgements prevent duplicate answers even after later batches',()=>{
  const word=makeWord(),original=createEmptySpace(spaceId(CODE),NOW),first=sync(original,[put(word)]);
  assert.equal(original.words.length,0,'the reducer does not mutate its input');
  const wrong=answer(word,false,{seq:2});
  const second=sync(first.state,[wrong]);
  assert.equal(second.response.words[0].mistakes,1);assert.equal(second.response.acks[CLIENT],2);
  const third=sync(second.state,[answer(word,true,{seq:3})]);
  const repeated=sync(third.state,[wrong]);
  assert.equal(repeated.changed,false);assert.equal(repeated.state.revision,third.state.revision);
  assert.equal(repeated.response.words[0].mistakes,1);assert.equal(repeated.response.words[0].masteryKo,1);
  assert.equal(repeated.response.acks[CLIENT],3);
});

test('out-of-order batches are sorted and a sequence gap rolls back the entire pure reduction',()=>{
  const word=makeWord(),empty=createEmptySpace(spaceId(CODE),NOW);
  const result=sync(empty,[answer(word,true,{seq:2}),put(word)]);
  assert.equal(result.response.acks[CLIENT],2);assert.equal(result.response.words[0].masteryKo,1);
  assert.throws(()=>sync(empty,[put(word),answer(word,true,{seq:3})]),error=>error.code==='SEQUENCE_GAP'&&error.details.expectedSeq===2);
  assert.equal(empty.words.length,0);assert.equal(empty.revision,0);
});

test('different clients can interleave answers without sharing sequence numbers or losing mistakes',()=>{
  const word=makeWord();let state=sync(createEmptySpace(spaceId(CODE),NOW),[put(word)]).state;
  state=sync(state,[answer(word,false,{seq:1,clientId:OTHER})],OTHER).state;
  state=sync(state,[answer(word,false,{seq:2})]).state;
  state=sync(state,[answer(word,true,{seq:2,clientId:OTHER,direction:'zh'})],OTHER).state;
  assert.equal(state.words[0].mistakes,2);assert.equal(state.words[0].masteryKo,0);assert.equal(state.words[0].masteryZh,1);
  assert.deepEqual(publicSnapshot(state).acks,{[CLIENT]:2,[OTHER]:2});
});

test('an edit resets learning and stale edit, answer and delete operations are acknowledged as conflicts',()=>{
  const word=makeWord();let state=sync(createEmptySpace(spaceId(CODE),NOW),[put(word),answer(word,false,{seq:2})]).state;
  const updated=makeWord({...word,chinese:'好朋友',generation:randomUUID()});
  state=sync(state,[put(updated,{seq:1,clientId:OTHER},word.generation)],OTHER).state;
  assert.equal(state.words[0].mistakes,0);assert.equal(state.words[0].lastPracticedAt,null);
  const operations=[answer(word,false,{seq:3}),put(makeWord({...word,chinese:'友人',generation:randomUUID()}),{seq:4},word.generation),operation('word-delete',{wordId:word.id,generation:word.generation},{seq:5})];
  const conflicted=sync(state,operations);
  assert.equal(conflicted.response.acks[CLIENT],5);assert.equal(conflicted.response.words[0].chinese,'好朋友');
  assert.ok(conflicted.response.conflicts.every(conflict=>conflict.reason==='generation-changed'));
  assert.deepEqual(sync(conflicted.state,operations).response.conflicts,conflicted.response.conflicts,'a lost response can retrieve recent conflicts');
});

test('deletion tombstones prevent stale resurrection and duplicate Korean words do not overwrite meanings',()=>{
  const word=makeWord();let state=sync(createEmptySpace(spaceId(CODE),NOW),[put(word)]).state;
  const duplicate=sync(state,[put(makeWord({chinese:'友人'}),{seq:1,clientId:OTHER})],OTHER);
  assert.equal(duplicate.response.conflicts[0].reason,'duplicate-word');assert.equal(duplicate.response.words[0].chinese,'朋友');state=duplicate.state;
  state=sync(state,[operation('word-delete',{wordId:word.id,generation:word.generation},{seq:2})]).state;
  const resurrect=sync(state,[put(word,{seq:2,clientId:OTHER}),answer(word,true,{seq:3,clientId:OTHER})],OTHER);
  assert.equal(resurrect.response.words.length,0);assert.deepEqual(resurrect.response.conflicts.map(value=>value.reason),['deleted','deleted']);
});

test('compact review matches existing reviewDetails for ordered answers and uses 1/3/7/14 day intervals',()=>{
  const seed=sync(createEmptySpace(spaceId(CODE),NOW),[put(makeWord())]).state.words[0];
  let word=seed;const history=[];
  const add=(direction,correct,retry,time)=>{
    const data={direction,correct,retry};word=compactReviewAnswer(word,data,time,time);
    history.push({direction,correct:Number(correct),is_retry:Number(retry),created_at:time});
    const reference=reviewDetails(word,history);
    assert.deepEqual({lastPracticedAt:word.lastPracticedAt,reviewAt:word.reviewAt,reviewDays:word.reviewDays},reference);
  };
  assert.equal(word.reviewAt,null);
  const round=time=>{add('ko',true,false,time);add('zh',true,false,time+1);};
  round(NOW);assert.equal(word.reviewDays,1);
  round(NOW+100);assert.equal(word.reviewDays,1);
  round(NOW+DAY);assert.equal(word.reviewDays,3);
  round(NOW+4*DAY);assert.equal(word.reviewDays,7);
  round(NOW+11*DAY);assert.equal(word.reviewDays,14);
  add('ko',false,false,NOW+12*DAY);assert.equal(word.reviewDays,0);
  add('ko',true,true,NOW+12*DAY+1);assert.equal(word.reviewDays,1);
  add('zh',true,false,NOW+12*DAY+2);assert.equal(word.reviewDays,1);
  for(let index=0;index<200;index++)add(index%3===0?'zh':'ko',index%11!==0,index%5===0,NOW+(13+index)*DAY);
  assert.ok(word.reviewProgress.cleanRounds<=4);assert.equal('answers' in word,false);
});

test('late offline mistakes reset safely while future clock skew cannot inflate the schedule',()=>{
  let word=sync(createEmptySpace(spaceId(CODE),NOW),[put(makeWord())]).state.words[0];
  word=compactReviewAnswer(word,{direction:'ko',correct:true,retry:false},NOW,NOW);
  word=compactReviewAnswer(word,{direction:'zh',correct:true,retry:false},NOW+1,NOW+1);
  const last=word.lastPracticedAt;
  word=compactReviewAnswer(word,{direction:'ko',correct:false,retry:false},NOW-DAY,NOW+2);
  assert.equal(word.lastPracticedAt,last);assert.equal(word.reviewDays,0);assert.equal(word.reviewAt,last);
  word=compactReviewAnswer(word,{direction:'ko',correct:true,retry:true},NOW+100*DAY,NOW+3);
  assert.equal(word.lastPracticedAt,NOW+3);assert.equal(word.reviewDays,1);
});

function graded(word,direction,rating,time,extras={}){return compactReviewAnswer(word,{direction,correct:rating!=='again',retry:false,rating,phase:'quiz',...extras},time,time);}
test('adaptive review grows each direction independently and same-day repetition keeps its original due date',()=>{
  let word=sync(createEmptySpace(spaceId(CODE),NOW),[put(makeWord())]).state.words[0];
  word=graded(word,'ko','good',NOW);word=graded(word,'zh','good',NOW+1);
  assert.equal(word.reviewDays,1);const due=word.reviewAt;
  word=graded(word,'ko','good',NOW+100);word=graded(word,'zh','good',NOW+101);assert.equal(word.reviewAt,due);
  word=graded(word,'ko','good',NOW+DAY);assert.equal(word.reviewProgress.srs.ko.intervalDays,6);assert.equal(word.reviewProgress.srs.zh.intervalDays,1);
  word=graded(word,'zh','hard',NOW+DAY+1);assert.equal(word.reviewProgress.srs.zh.intervalDays,2);assert.equal(word.mistakes,0);assert.equal(word.reviewAt,NOW+3*DAY+1);
});
test('correcting Good to Hard reschedules from the original interval instead of the already expanded interval',()=>{
  let word=sync(createEmptySpace(spaceId(CODE),NOW),[put(makeWord())]).state.words[0];
  word=graded(word,'zh','good',NOW);
  const direct=graded(word,'zh','hard',NOW+DAY);
  let corrected=graded(word,'zh','good',NOW+DAY);assert.equal(corrected.reviewProgress.srs.zh.intervalDays,6);
  corrected=graded(corrected,'zh','hard',NOW+DAY,{correction:true});
  assert.equal(corrected.reviewProgress.srs.zh.intervalDays,direct.reviewProgress.srs.zh.intervalDays);
  assert.equal(corrected.reviewProgress.srs.zh.repetitions,direct.reviewProgress.srs.zh.repetitions);
  assert.equal(corrected.reviewProgress.srs.zh.dueAt,direct.reviewProgress.srs.zh.dueAt);
});
test('Again persists a ten-minute relearning step and a successful retry starts again at one day',()=>{
  let word=sync(createEmptySpace(spaceId(CODE),NOW),[put(makeWord())]).state.words[0];
  word=graded(word,'ko','good',NOW);word=graded(word,'zh','good',NOW);
  word=graded(word,'zh','again',NOW+DAY,{correction:true});assert.equal(word.masteryZh,0);assert.equal(word.mistakes,1);assert.equal(word.reviewProgress.srs.zh.dueAt,NOW+DAY+600000);
  word=graded(word,'zh','good',NOW+DAY+100,{retry:true});assert.equal(word.reviewProgress.srs.zh.intervalDays,1);assert.equal(word.reviewProgress.srs.zh.dueAt,NOW+2*DAY+100);
  const due=word.reviewProgress.srs.zh.dueAt;word=graded(word,'zh','good',NOW+DAY+200,{retry:true});assert.equal(word.reviewProgress.srs.zh.dueAt,due);
});
test('recall ratings persist without claiming quiz mastery, and old intervals migrate lazily',()=>{
  const seed=sync(createEmptySpace(spaceId(CODE),NOW),[put(makeWord())]).state.words[0];
  const known=graded(seed,'zh','good',NOW,{phase:'recall'});assert.equal(known.masteryZh,0);assert.equal(known.reviewAt,null);
  const fuzzy=graded(seed,'zh','hard',NOW,{phase:'recall'});const checked=graded(fuzzy,'zh','good',NOW+1);assert.equal(checked.mistakes,0);assert.ok(checked.reviewProgress.srs.zh.ease<2.5);
  const legacy={...seed,masteryKo:1,masteryZh:1,lastPracticedAt:NOW-DAY,reviewDays:7,reviewAt:NOW+6*DAY};
  const migrated=graded(legacy,'ko','good',NOW);assert.equal(migrated.reviewAt,legacy.reviewAt);assert.equal(migrated.reviewProgress.srs.ko.intervalDays,7);
});
test('adaptive backup import preserves independently scheduled dates and clamps future time consistently',()=>{
  let word=sync(createEmptySpace(spaceId(CODE),NOW),[put(makeWord())]).state.words[0];
  word=graded(word,'ko','good',NOW);word=graded(word,'zh','good',NOW+1);word=graded(word,'ko','good',NOW+DAY);
  const imported=sync(createEmptySpace(spaceId(CODE),NOW),[operation('space-import',{words:[word]})],CLIENT,NOW+DAY).state.words[0];
  assert.deepEqual(imported.reviewProgress.srs,word.reviewProgress.srs);assert.equal(imported.reviewAt,word.reviewAt);
  const future=structuredClone(word);future.lastPracticedAt=NOW+10*DAY;future.reviewProgress.srs.ko.dueAt=NOW+100*DAY;
  const clamped=sync(createEmptySpace(spaceId(CODE),NOW),[operation('space-import',{words:[future]})],CLIENT,NOW).state.words[0];
  assert.ok(clamped.reviewProgress.srs.ko.dueAt<=NOW+90*DAY);
  assert.doesNotThrow(()=>sync(createEmptySpace(spaceId(CODE),NOW),[operation('space-import',{words:[clamped]})],CLIENT,NOW));
});
test('a full thousand-word library with both adaptive schedules remains below the storage limit',()=>{
  const words=Array.from({length:1000},(_,index)=>{let word={...makeWord(),korean:'단어'+index,chinese:'释义'+index,masteryKo:0,masteryZh:0,mistakes:0,lastPracticedAt:null,reviewDays:null,reviewAt:null};word=graded(word,'ko','good',NOW);return graded(word,'zh','good',NOW);});
  const state=sync(createEmptySpace(spaceId(CODE),NOW),[operation('space-import',{words})]).state;
  assert.equal(state.words.length,1000);assert.ok(new TextEncoder().encode(JSON.stringify(state)).length<SYNC_LIMITS.spaceBytes);
});
test('inconsistent grades and malformed adaptive backup state are rejected before committing',()=>{
  const word=makeWord(),good=answer(word,true);good.payload.rating='again';assert.throws(()=>validateSyncRequest({code:CODE,clientId:CLIENT,operations:[good]}),/不一致/);
  let learned=graded({...word,masteryKo:0,masteryZh:0,lastPracticedAt:null,reviewDays:null,reviewAt:null},'zh','good',NOW);learned.reviewProgress.srs.zh.ease=99;
  assert.throws(()=>sync(createEmptySpace(spaceId(CODE),NOW),[operation('space-import',{words:[learned]})]),/记忆计划/);
});

test('legacy import preserves progress and cannot replace a nonempty space or a deleted library',()=>{
  const legacy=makeWord({masteryKo:1,masteryZh:1,mistakes:3,lastPracticedAt:NOW-DAY,reviewAt:NOW+2*DAY,reviewDays:3});
  const imported=sync(createEmptySpace(spaceId(CODE),NOW),[operation('space-import',{words:[legacy]})]);
  const word=imported.response.words[0];assert.equal(word.masteryKo,1);assert.equal(word.masteryZh,1);assert.equal(word.mistakes,3);assert.equal(word.reviewAt,NOW+2*DAY);assert.equal(word.reviewProgress.cleanRounds,2);
  const conflict=sync(imported.state,[operation('space-import',{words:[makeWord({korean:'학교',chinese:'学校'})]},{seq:2})]);
  assert.equal(conflict.response.conflicts[0].reason,'space-not-empty');assert.equal(conflict.response.words[0].korean,'친구');
  const deleted=sync(imported.state,[operation('word-delete',{wordId:word.id,generation:word.generation},{seq:2})]);
  assert.equal(sync(deleted.state,[operation('space-import',{words:[legacy]},{seq:3})]).response.conflicts[0].reason,'space-not-empty');
  assert.throws(()=>sync(createEmptySpace(spaceId(CODE),NOW),[operation('space-import',{words:[legacy,{...legacy}]})]),/重复/);
  assert.throws(()=>sync(createEmptySpace(spaceId(CODE),NOW),[operation('space-import',{words:[{...legacy,mistakes:-1}]})]),/学习进度/);
});

test('offline projection handles more than 100 pending answers and starts from imported progress',()=>{
  const word=makeWord({masteryKo:1,masteryZh:1,mistakes:5,lastPracticedAt:NOW-1,reviewDays:1});
  const operations=[operation('space-import',{words:[word]}),...Array.from({length:205},(_,index)=>answer(word,false,{seq:index+2,createdAt:NOW+index}))];
  const projected=projectSnapshot({spaceId:'local:'+randomUUID(),schemaVersion:1,words:[],acks:{}},operations,{code:CODE,clientId:CLIENT,now:NOW+300});
  assert.equal(projected.words[0].mistakes,210);assert.equal(projected.acks[CLIENT],206);assert.equal(projected.conflicts.length,0);
});

test('backup append imports progress only into a new word and rejects overwrite of existing meanings',()=>{
  const original=makeWord(),newWord=makeWord({korean:'학교',chinese:'学校'});
  let state=sync(createEmptySpace(spaceId(CODE),NOW),[put(original)]).state;
  const progress={masteryKo:1,masteryZh:1,mistakes:5,lastPracticedAt:NOW-2*DAY,reviewDays:7};
  const imported=put(newWord,{seq:2});imported.payload.importedProgress=progress;
  const duplicate=put(makeWord({chinese:'友人'}),{seq:3});duplicate.payload.importedProgress=progress;
  const result=sync(state,[imported,duplicate]);state=result.state;
  const school=state.words.find(word=>word.id===newWord.id);
  assert.equal(school.mistakes,5);assert.equal(school.reviewDays,7);assert.equal(school.reviewAt,NOW+5*DAY);assert.equal(school.reviewProgress.cleanRounds,3);
  assert.equal(state.words.find(word=>word.id===original.id).chinese,'朋友');assert.equal(result.response.conflicts[0].reason,'duplicate-word');
  const edit=put(makeWord({...newWord,generation:randomUUID(),chinese:'校园'}),{seq:4},newWord.generation);edit.payload.importedProgress=progress;
  assert.throws(()=>sync(state,[edit]),error=>error.code==='INVALID_PROGRESS');
});

test('device and storage limits fail without dropping local operations, conflict receipts stay bounded',()=>{
  const word=makeWord(),empty=createEmptySpace(spaceId(CODE),NOW);
  empty.clients=Object.fromEntries(Array.from({length:SYNC_LIMITS.clients},()=>[randomUUID(),{acked:0,conflicts:[]} ]));
  assert.throws(()=>sync(empty,[put(word)]),error=>error.code==='DEVICE_LIMIT');
  let state=sync(createEmptySpace(spaceId(CODE),NOW),[put(word)]).state;
  for(let batch=0;batch<3;batch++) {
    const wrongGeneration={...word,generation:randomUUID()};
    state=sync(state,Array.from({length:100},(_,index)=>answer(wrongGeneration,true,{seq:batch*100+index+2}))).state;
  }
  assert.equal(state.clients[CLIENT].conflicts.length,100);assert.equal(state.clients[CLIENT].acked,301);assert.equal(state.words[0].masteryKo,0);
  assert.throws(()=>applySync(state,{code:CODE,clientId:CLIENT,operations:[]},{spaceId:'another-space'}),error=>error.code==='SPACE_MISMATCH');
});

// A deterministic optimistic-transaction double exercises collisions and ambiguous commits.
function memoryDatabase() {
  const records=new Map(),versions=new Map();let starts=0,commits=0,failAfterCommit=0;
  return {records,get starts(){return starts;},get commits(){return commits;},loseNextCommit(){failAfterCommit++;},async startTransaction(){
    starts++;const observed=new Map(),staged=new Map();
    return {collection(){return {doc(id){return {async get(){observed.set(id,versions.get(id)||0);const value=records.get(id);await Promise.resolve();return {data:value?[structuredClone(value)]:[]};},async update(value){staged.set(id,{_id:id,...structuredClone(value)});}};},async add(value){if(!observed.has(value._id))observed.set(value._id,versions.get(value._id)||0);if(records.has(value._id))throw new Error('duplicate key');staged.set(value._id,structuredClone(value));}};},async commit(){
      for(const [id,version]of observed)if((versions.get(id)||0)!==version)throw new Error('write conflict');
      for(const [id,value]of staged){records.set(id,value);versions.set(id,(versions.get(id)||0)+1);}commits++;
      if(failAfterCommit){failAfterCommit--;throw new Error('response lost after commit');}
    },async rollback(){staged.clear();}};
  }};
}
const ORIGIN='https://spring.example';
const config={collection:'spring_spaces',allowedOrigins:[ORIGIN],allowNoOrigin:false};
const http=(request,extra={})=>({httpMethod:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify(request),...extra});
const result=response=>({status:response.statusCode,data:JSON.parse(response.body)});

test('cloud adapter hashes bearer codes, isolates spaces and never auto-creates during restore',async()=>{
  const db=memoryDatabase(),handler=createHandler({database:db,protocol,config,now:()=>NOW});
  let response=result(await handler(http({code:CODE,clientId:CLIENT,operations:[]})));
  assert.equal(response.status,404);assert.equal(db.records.size,0);
  const word=makeWord();response=result(await handler(http({code:CODE,clientId:CLIENT,operations:[put(word)],create:true})));
  assert.equal(response.status,200);assert.equal(response.data.words.length,1);assert.equal(db.records.size,1);
  const record=db.records.get(key(CODE));assert.equal(record._id,key(CODE));assert.equal(JSON.stringify(record).includes(CODE),false);assert.equal(JSON.stringify(response.data).includes(CODE),false);
  const alternate='SC-'+randomUUID();const other=result(await handler(http({code:alternate,clientId:OTHER,create:true})));
  assert.equal(other.status,200);assert.equal(other.data.words.length,0);
  const forbidden=result(await handler(http({code:alternate,clientId:OTHER,operations:[answer(word,false,{clientId:OTHER})]})));
  assert.equal(forbidden.status,200);assert.equal(forbidden.data.conflicts[0].reason,'missing');assert.equal(db.records.get(key(CODE)).words[0].mistakes,0);
});

test('cloud transaction collisions merge both clients instead of losing an entire word or answer',async()=>{
  const db=memoryDatabase(),handler=createHandler({database:db,protocol,config,now:()=>NOW});
  const word=makeWord(),otherWord=makeWord({korean:'학교',chinese:'学校'});
  const created=await Promise.all([
    handler(http({code:CODE,clientId:CLIENT,create:true,operations:[put(word)]})),
    handler(http({code:CODE,clientId:OTHER,create:true,operations:[put(otherWord,{clientId:OTHER})]}))
  ]);
  assert.ok(created.every(response=>response.statusCode===200));assert.equal(db.records.get(key(CODE)).words.length,2);assert.ok(db.starts>=3,'a colliding transaction retried');
  const answers=await Promise.all([
    handler(http({code:CODE,clientId:CLIENT,operations:[answer(word,false,{seq:2})]})),
    handler(http({code:CODE,clientId:OTHER,operations:[answer(word,false,{seq:2,clientId:OTHER})]}))
  ]);
  assert.ok(answers.every(response=>response.statusCode===200));assert.equal(db.records.get(key(CODE)).words.find(item=>item.id===word.id).mistakes,2);
});

test('an uncertain cloud commit and client retry never increment a mistake twice',async()=>{
  const db=memoryDatabase(),handler=createHandler({database:db,protocol,config,now:()=>NOW}),word=makeWord();
  await handler(http({code:CODE,clientId:CLIENT,create:true,operations:[put(word)]}));
  db.loseNextCommit();const request={code:CODE,clientId:CLIENT,operations:[answer(word,false,{seq:2})]};
  assert.equal((await handler(http(request))).statusCode,200);assert.equal((await handler(http(request))).statusCode,200);
  assert.equal(db.records.get(key(CODE)).words[0].mistakes,1);
});

test('cloud CORS and input errors fail before accessing any vocabulary document',async()=>{
  const db=memoryDatabase(),handler=createHandler({database:db,protocol,config,now:()=>NOW});
  assert.equal((await handler(http({code:CODE,clientId:CLIENT},{headers:{origin:'https://other.example','content-type':'application/json'}}))).statusCode,403);
  assert.equal((await handler(http({code:CODE,clientId:CLIENT},{headers:{'content-type':'application/json'}}))).statusCode,403);
  const preflight=await handler({httpMethod:'OPTIONS',headers:{Origin:ORIGIN,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}});
  assert.equal(preflight.statusCode,204);assert.equal(preflight.headers['Access-Control-Allow-Origin'],ORIGIN);assert.equal(preflight.headers['Access-Control-Allow-Credentials'],undefined);
  assert.equal((await handler({httpMethod:'OPTIONS',headers:{origin:ORIGIN,'access-control-request-method':'GET'}})).statusCode,403);
  assert.equal((await handler(http({code:CODE,clientId:CLIENT},{body:'not json'}))).statusCode,400);
  assert.equal((await handler(http({code:CODE,clientId:CLIENT},{body:'x'.repeat(SYNC_LIMITS.requestBytes+1)}))).statusCode,413);
  assert.equal(db.starts,0);assert.equal(db.records.size,0);
  const schema=JSON.parse(readFileSync(new URL('../unicloud/cloudfunctions/spring-sync/spring_spaces.schema.json',import.meta.url),'utf8'));
  assert.deepEqual(schema.permission,{read:false,create:false,update:false,delete:false});
});
