import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'..');
const {default:worker,lookupWord,reviewDetails,wordRecording}=await import(pathToFileURL(resolve(root,'dist/server/index.js')));
function database(){
  const sql=new DatabaseSync(':memory:');for(const name of readdirSync(resolve(root,'drizzle')).filter(n=>n.endsWith('.sql')))sql.exec(readFileSync(resolve(root,'drizzle',name),'utf8'));
  const wrap=(s,args=[])=>({bind(...next){return wrap(s,next);},async first(){return s.get(...args)||null;},async all(){return{results:s.all(...args)};},async run(){return{meta:{changes:Number(s.run(...args).changes)}};}});
  return{sql,DB:{prepare(query){return wrap(sql.prepare(query));},async batch(stmts){sql.exec('BEGIN');try{const out=[];for(const stmt of stmts)out.push(await stmt.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}}};
}
const call=async(db,path,body,method=body===undefined?'GET':'POST',user='owner-a',extra={})=>{
  const headers={...(user?{'oai-authenticated-user-id':user,'X-Learning-Space':user}:{}),...extra};if(body!==undefined)headers['content-type']='application/json';
  const response=await worker.fetch(new Request('https://test.invalid'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),db||{});
  return{status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
};
test('local dictionary performs real Chinese/Korean lookups without external calls',async()=>{
  const apple=await lookupWord('苹果',()=>{throw new Error('unexpected fetch');});assert.equal(apple.korean,'사과');assert.equal(apple.chinese,'苹果');
  assert.equal((await lookupWord('학교')).chinese,'学校');assert.equal((await lookupWord('朋友')).korean,'친구');
});

test('published worker and local edition recommend primary beginner senses consistently',async()=>{
  const offline=()=>{throw new Error('No external translation request is allowed');};
  for(const [query,korean] of [['白天','낮'],['一天','하루'],['下午','오후'],['便宜','싸다']])assert.equal((await lookupWord(query,offline)).korean,korean);
  const daytime=await call({},'/api/lookup',{text:'白天'},'POST',null);
  assert.equal(daytime.status,200);assert.equal(daytime.data.korean,'낮');
  assert.ok(daytime.data.candidates.some(candidate=>candidate.korean==='날'&&candidate.chinese==='白天'));
  assert.equal((await wordRecording(daytime.data.korean,daytime.data.chinese)).entryId,'64497');
  for(const [path,type] of [['/lookup-ranking.mjs','text/javascript'],['/krdict-lookup-priority.json','application/json']]){
    const response=await worker.fetch(new Request('https://test.invalid'+path),{});
    assert.equal(response.status,200);assert.ok(response.headers.get('content-type').startsWith(type));
    if(type==='application/json')assert.equal((await response.json()).entries['낮'][0][1],1);
  }
});
test('original audio metadata distinguishes homonyms and does not guess an ambiguous reading',async()=>{
  assert.equal((await wordRecording('친구','朋友')).entryId,'29742');
  assert.equal((await wordRecording('학교','学校')).entryId,'73276');
  assert.equal((await wordRecording('봄','春')).entryId,'20219');
  assert.equal((await wordRecording('사과','苹果')).entryId,'66371');
  assert.equal((await wordRecording('사과','道歉')).entryId,'15830');
  assert.equal((await wordRecording('사과','苹果（水果）')).entryId,'66371');
  assert.equal((await wordRecording('눈','雪花')).entryId,'20198');
  assert.equal(await wordRecording('사과','赔礼'),null);
  assert.equal(await wordRecording('사과','苹果，道歉'),null);
  assert.equal(await wordRecording('새로운발음확인테스트','发音验证'),null);
});
test('online query validates language pair and never saves quota or English error messages as meanings',async()=>{
  const unknownKo='새로운번역테스트단어',unknownZh='新的翻译测试用词';
  const okay=await lookupWord(unknownKo,async url=>{assert.equal(url.searchParams.get('langpair'),'ko|zh-CN');return Response.json({responseStatus:200,quotaFinished:false,responseData:{translatedText:'星星'}});});assert.equal(okay.chinese,'星星');
  const chinese=await lookupWord(unknownZh,async url=>{assert.equal(url.searchParams.get('langpair'),'zh-CN|ko');return Response.json({responseStatus:200,responseData:{translatedText:'별'}});});assert.equal(chinese.korean,'별');
  await assert.rejects(lookupWord(unknownKo,async()=>Response.json({responseStatus:200,responseData:{translatedText:'QUERY LENGTH LIMIT EXCEEDED'}})),/没有查到合适/);
  await assert.rejects(lookupWord(unknownKo,async()=>Response.json({responseStatus:403,quotaFinished:true})),/额度/);
  await assert.rejects(lookupWord('朋友 친구'),/一种语言/);await assert.rejects(lookupWord(''),/请输入/);
});

test('official Korean-Chinese dictionary searches both languages with no external service and keeps homonym meanings separate',async()=>{
  const offline=()=>{throw new Error('No external translation request is allowed');};
  assert.equal((await lookupWord('가치관',offline)).chinese,'价值观');assert.equal((await lookupWord('价值观',offline)).korean,'가치관');
  const ambiguity=await lookupWord('사과',offline);assert.ok(ambiguity.candidates.some(c=>c.chinese==='苹果'));assert.ok(ambiguity.candidates.some(c=>c.chinese==='道歉'));
  const synonyms=await lookupWord('责任心',offline);assert.ok(synonyms.korean==='책임감'||synonyms.candidates?.some(c=>c.korean==='책임감'));
  const own=await lookupWord('헷갈리다',offline);assert.ok(own.chinese.includes('错乱')||own.chinese.includes('混淆'));
  const verb=await lookupWord('가다',offline);assert.ok(verb.candidates.length>16);assert.ok(verb.candidates.some(c=>c.chinese==='去世'));
});

test('dictionary initialization failure falls back and retries successfully on the next query',async()=>{
  const fresh=await import(pathToFileURL(resolve(root,'dist/server/index.js')).href+'?loader-recovery='+crypto.randomUUID());
  const original=globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream=class {constructor(){throw new Error('temporary initialization failure');}};
    assert.equal((await fresh.lookupWord('친구',()=>{throw new Error('unexpected external call');})).chinese,'朋友');
  } finally {globalThis.DecompressionStream=original;}
  assert.equal((await fresh.lookupWord('가치관',()=>{throw new Error('dictionary should recover');})).chinese,'价值观');
});

test('read-only lookup does not require a learning database or create an identity, and retains origin checks',async()=>{
  const result=await call({},'/api/lookup',{text:'가치관'},'POST',null);
  assert.equal(result.status,200);assert.equal(result.data.chinese,'价值观');assert.equal(result.cookie,undefined);
  const blocked=await call({},'/api/lookup',{text:'가치관'},'POST',null,{origin:'https://evil.invalid'});assert.equal(blocked.status,403);
});

test('a transient external translation error is retried once without accepting an error page as meaning',async()=>{
  let calls=0;const result=await lookupWord('새로운번역테스트단어',async()=>{calls++;return calls===1?new Response('Unavailable',{status:503}):Response.json({responseStatus:200,responseData:{translatedText:'测试词'}});});assert.equal(calls,2);assert.equal(result.chinese,'测试词');
  calls=0;await assert.rejects(lookupWord('새로운번역테스트단어',async()=>{calls++;return new Response('Unavailable',{status:503});}),/暂时没有响应/);assert.equal(calls,2);
});
test('API requires same-origin mutations, with no GPT sign-in requirement',async()=>{
  const db=database();try{const noAuth=await call(db,'/api/session',undefined,'GET',null);assert.equal(noAuth.status,200);assert.ok(noAuth.data.learningCode.startsWith('SC-'));assert.ok(noAuth.headers.get('set-cookie').includes('HttpOnly; SameSite=Lax; Secure'));}finally{db.sql.close();}
  const wrongOrigin=await call({},'/api/words',{korean:'사과',chinese:'苹果'},'POST','owner-a',{origin:'https://evil.invalid'});assert.equal(wrongOrigin.status,403);
});
test('learning code restores vocabulary and progress in another browser and invalid codes preserve identity',async()=>{
  const db=database();try{
    const space=await call(db,'/api/session',undefined,'GET',null);
    const extra={Cookie:space.cookie,'X-Learning-Space':space.data.spaceId};
    await call(db,'/api/words',{korean:'친구',chinese:'朋友'},'POST',null,extra);
    const word=(await call(db,'/api/words',undefined,'GET',null,extra)).data.words[0];
    await call(db,'/api/answers',{id:'personal-answer-id',wordId:word.id,direction:'ko',correct:true,retry:false},'POST',null,extra);
    const restored=await call(db,'/api/session',{code:space.data.learningCode},'POST',null);
    assert.equal(restored.data.spaceId,space.data.spaceId);
    const otherExtra={Cookie:restored.cookie,'X-Learning-Space':restored.data.spaceId};
    const recovered=(await call(db,'/api/words',undefined,'GET',null,otherExtra)).data.words[0];assert.equal(recovered.korean,'친구');assert.equal(recovered.masteryKo,1);
    const count=db.sql.prepare('SELECT COUNT(*) as n FROM learning_spaces').get().n;
    const invalid=await call(db,'/api/session',{code:'SC-'+crypto.randomUUID()},'POST',null,otherExtra);assert.equal(invalid.status,404);assert.equal(invalid.cookie,undefined);assert.equal(db.sql.prepare('SELECT COUNT(*) as n FROM learning_spaces').get().n,count);
    const unchanged=await call(db,'/api/session',undefined,'GET',null,otherExtra);assert.equal(unchanged.data.learningCode,space.data.learningCode);
    const different=await call(db,'/api/session',undefined,'GET',null);
    const stale=await call(db,'/api/words',{korean:'학교',chinese:'学校'},'POST',null,{Cookie:different.cookie,'X-Learning-Space':space.data.spaceId});assert.equal(stale.status,409);
    const staleRead=await call(db,'/api/words',undefined,'GET',null,{Cookie:different.cookie,'X-Learning-Space':space.data.spaceId});assert.equal(staleRead.status,409);
    const ownRead=await call(db,'/api/words',undefined,'GET',null,otherExtra);assert.equal(ownRead.data.spaceId,space.data.spaceId);assert.ok(ownRead.data.words[0].reviewAt>0);
    assert.equal((await call(db,'/api/words',undefined,'GET',null,{Cookie:different.cookie})).data.words.length,0);
  }finally{db.sql.close();}
});
test('review intervals grow after spaced clean rounds; same-day drills and retries do not inflate them',()=>{
  const day=86400000,word={masteryKo:1,masteryZh:1},answers=[];
  const round=(time,correct=true)=>{for(const direction of ['ko','zh'])answers.push({direction,correct:Number(correct),is_retry:0,created_at:time+(direction==='zh'?1:0)});};
  assert.equal(reviewDetails(word,[]).reviewAt,null);
  round(100);assert.equal(reviewDetails(word,answers).reviewDays,1);
  round(200);assert.equal(reviewDetails(word,answers).reviewDays,1);
  round(100+day);assert.equal(reviewDetails(word,answers).reviewDays,3);
  round(100+4*day);assert.equal(reviewDetails(word,answers).reviewDays,7);
  round(100+11*day);let details=reviewDetails(word,answers);assert.equal(details.reviewDays,14);assert.equal(details.reviewAt,details.lastPracticedAt+14*day);
  answers.push({direction:'ko',correct:0,is_retry:0,created_at:12*day});assert.equal(reviewDetails({...word,masteryKo:0},answers).reviewDays,0);
  answers.push({direction:'ko',correct:1,is_retry:1,created_at:12*day+1});assert.equal(reviewDetails(word,answers).reviewDays,1);
  answers.push({direction:'zh',correct:1,is_retry:0,created_at:12*day+2});assert.equal(reviewDetails(word,answers).reviewDays,1);
});
test('a second device writing during a read cannot mix old mastery with new answer history',async()=>{
  const db=database();try {
    await call(db,'/api/words',{korean:'친구',chinese:'朋友'});
    const word=(await call(db,'/api/words')).data.words[0];
    for(const direction of ['ko','zh'])await call(db,'/api/answers',{id:'snapshot-'+direction,wordId:word.id,direction,correct:true,retry:false});
    const before=(await call(db,'/api/words')).data.words[0];
    const prepare=db.DB.prepare;let injected=false;
    db.DB.prepare=query=>{
      const wrap=stmt=>({bind(...args){return wrap(stmt.bind(...args));},first:()=>stmt.first(),run:()=>stmt.run(),async all(){
        const rows=await stmt.all();
        if(!injected&&/FROM words/i.test(query)) {
          injected=true;
          db.sql.prepare('UPDATE words SET mastery_ko=0,mistakes=mistakes+1 WHERE id=?').run(word.id);
          db.sql.prepare('INSERT INTO answers (id,user_id,word_id,direction,correct,is_retry,created_at) VALUES (?,?,?,?,?,?,?)').run('snapshot-concurrent','owner-a',word.id,'ko',0,0,before.lastPracticedAt+10000);
        }
        return rows;
      }});return wrap(prepare(query));
    };
    const snapshot=(await call(db,'/api/words')).data.words[0];
    assert.equal(injected,true);assert.equal(snapshot.masteryKo,1);assert.equal(snapshot.lastPracticedAt,before.lastPracticedAt);assert.equal(snapshot.reviewAt,before.reviewAt);
    const latest=(await call(db,'/api/words')).data.words[0];assert.equal(latest.masteryKo,0);assert.equal(latest.reviewDays,0);assert.equal(latest.reviewAt,before.lastPracticedAt+10000);
  }finally{db.sql.close();}
});
test('legacy GPT-linked vocabulary migrates to a stable learning code and works after sign-out',async()=>{
  const db=database();try{
    await call(db,'/api/words',{korean:'사과',chinese:'苹果'});
    const a=await call(db,'/api/session'),b=await call(db,'/api/session');assert.equal(a.data.learningCode,b.data.learningCode);
    const signedOut=await call(db,'/api/session',{code:a.data.learningCode},'POST',null);
    assert.equal((await call(db,'/api/words',undefined,'GET',null,{Cookie:signedOut.cookie})).data.words.length,1);
  }finally{db.sql.close();}
});
test('word CRUD persists, normalizes duplicates, and isolates owners',async()=>{
  const db=database();try{
    assert.equal((await call(db,'/api/words',{korean:'  사과 ',chinese:'苹果'})).status,201);
    assert.equal((await call(db,'/api/words',{korean:'사과'.normalize('NFD'),chinese:'苹果'})).status,409);
    let words=(await call(db,'/api/words')).data.words;assert.equal(words.length,1);
    assert.equal((await call(db,'/api/words',undefined,'GET','owner-b')).data.words.length,0);
    const id=words[0].id;
    assert.equal((await call(db,'/api/words/'+id,{korean:'사과',chinese:'苹果（水果）'},'PATCH','owner-b')).status,404);
    assert.equal((await call(db,'/api/words/'+id,{korean:'사과',chinese:'苹果（水果）'},'PATCH')).status,200);
    words=(await call(db,'/api/words')).data.words;assert.equal(words[0].chinese,'苹果（水果）');
    assert.equal((await call(db,'/api/words/'+id,undefined,'DELETE')).status,200);assert.equal((await call(db,'/api/words')).data.words.length,0);
  }finally{db.sql.close();}
});
test('answer retries are idempotent and mastery requires both directions',async()=>{
  const db=database();try{
    await call(db,'/api/words',{korean:'친구',chinese:'朋友'});const word=(await call(db,'/api/words')).data.words[0];
    const answer={id:'same-answer-id',wordId:word.id,direction:'ko',correct:false,retry:false};
    assert.equal((await call(db,'/api/answers',answer)).status,200);assert.equal((await call(db,'/api/answers',answer)).status,200);
    let current=(await call(db,'/api/words')).data.words[0];assert.equal(current.mistakes,1);assert.equal(db.sql.prepare('SELECT COUNT(*) as c FROM answers').get().c,1);
    await call(db,'/api/answers',{...answer,id:'retry-answer-id',correct:true,retry:true});
    current=(await call(db,'/api/words')).data.words[0];assert.equal(current.masteryKo,1);assert.equal(current.masteryZh,0);
    await call(db,'/api/answers',{...answer,id:'second-direction-id',direction:'zh',correct:true});
    current=(await call(db,'/api/words')).data.words[0];assert.equal(current.masteryZh,1);
    assert.equal((await call(db,'/api/answers',{...answer,correct:true})).status,409);
    assert.equal((await call(db,'/api/answers',answer,'POST','owner-b')).status,404);
    await call(db,'/api/words/'+word.id,{korean:'친구',chinese:'朋友（友人）'},'PATCH');
    current=(await call(db,'/api/words')).data.words[0];assert.equal(current.masteryKo,0);assert.equal(current.masteryZh,0);assert.equal(db.sql.prepare('SELECT COUNT(*) as c FROM answers').get().c,0);
  }finally{db.sql.close();}
});
