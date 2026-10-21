import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as core from '../src/core.mjs';

const source=(await readFile(new URL('../src/app.mjs',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/\ninit\(\);\s*$/,'');
const word={id:'00000000-0000-4000-8000-000000000001',generation:'00000000-0000-4000-8000-000000000002',korean:'친구',chinese:'朋友',masteryKo:0,masteryZh:0,mistakes:0};
function fixture(auto='on') {
  const nodes=new Map(),plays=[],events=[],stored=new Map([['spring-auto-audio',auto]]),listeners=[],testWord={...word};
  function node(selector){
    if(!nodes.has(selector))nodes.set(selector,{dataset:{},style:{setProperty(){}},classList:{add(){},remove(){},toggle(){}},hidden:false,disabled:false,textContent:'',innerHTML:'',value:'',open:false,offsetWidth:100,
      setAttribute(){},getAttribute(){return '听韩文发音';},focus(){},append(){},replaceChildren(){},addEventListener(type,fn){listeners.push({selector,type,fn});},querySelector:node,showModal(){this.open=true;},close(){this.open=false;}});
    return nodes.get(selector);
  }
  const document={hidden:false,body:node('body'),documentElement:node('html'),querySelector:s=>s==='dialog[open]'?null:node(s),querySelectorAll:()=>[],addEventListener(type,fn,capture){listeners.push({selector:'document',type,fn,capture});}};
  const context=vm.createContext({...core,DICTIONARY:[],EXAMPLES:{},document,window:{matchMedia:()=>({matches:true}),addEventListener(){},scrollTo(){},Audio:class{}},innerHeight:850,innerWidth:1200,
    navigator:{onLine:true},localStorage:{getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,v)},BroadcastChannel:undefined,
    crypto:globalThis.crypto,structuredClone,console,URL,AbortController,setTimeout:()=>1,clearTimeout(){},
    createLocalStore:()=>({answer:async()=>{events.push('saved');return {words:[testWord]};}}),
    createOfflineLookup:()=>({meanings:async()=>[]}),
    createWordAudio:()=>({stop(){},play(request,preferred,settings){plays.push({request,preferred,settings});events.push('speak');},unlock(){events.push('unlock');},canSpeak:()=>true,localVoiceAvailable:()=>true}),testWord});
  vm.runInContext(source,context);
  vm.runInContext("words=[testWord];currentSpace={spaceId:'local:test'};lastGroup=[testWord];lastLabel='第 1 组';studyCards=[testWord];studyIndex=0;tab='study';",context);
  return {context,plays,events,node,listeners,run:code=>vm.runInContext(code,context)};
}
function prepareQuiz(f,direction){
  f.context.makeOptions=()=>[
    {label:direction==='ko'?'친구':'朋友',correct:true},
    {label:direction==='ko'?'학교':'学校',correct:false},
    {label:direction==='ko'?'사과':'苹果',correct:false},
    {label:direction==='ko'?'어제':'昨天',correct:false}
  ];
  f.run(`tab='quiz';session=makeSession([testWord]);session.queue[0].direction='${direction}';renderQuestion()`);
}
function clickHandler(f,selector,event={target:{closest:()=>null}}){
  const handler=f.listeners.find(item=>item.selector===selector&&item.type==='click'&&!item.capture);
  assert.ok(handler,`missing click handler for ${selector}`);
  return handler.fn(event);
}
test('a new recall card speaks once and each rating replays before its local save',async()=>{
  for(const rating of ['known','maybe','unknown']){
    const f=fixture();f.run('renderStudyCard()');assert.equal(f.plays.length,1);
    await f.run(`assessStudy('${rating}')`);
    assert.equal(f.plays.length,2);assert.deepEqual(f.events,['speak','speak','saved']);
    for(const play of f.plays){assert.equal(play.request.text,'친구');assert.equal(play.settings.restart,true);assert.equal(play.settings.automatic,true);}
  }
});
test('remembered then corrected to forgotten replays the same word again',async()=>{
  const f=fixture();f.run('renderStudyCard()');await f.run("assessStudy('known')");await f.run("assessStudy('unknown',{corrected:true})");
  assert.equal(f.plays.length,3);assert.equal(f.plays.at(-1).request.text,'친구');
});
test('both choice directions stay silent before selection and read the correct Korean word after any answer',async()=>{
  for(const direction of ['ko','zh'])for(const index of [0,1,-1]){
    const f=fixture();prepareQuiz(f,direction);
    assert.equal(f.plays.length,0,`${direction}: no pronunciation before answering`);
    assert.equal(f.node('[data-speak="quiz-word"]').disabled,false);
    await f.run(`choose(${index})`);
    assert.equal(f.plays.length,1,`${direction}: one pronunciation after answer ${index}`);
    assert.equal(f.plays[0].request.text,'친구','always read the answer word, including a wrong selection');
    assert.equal(f.plays[0].settings.automatic,true);
    assert.equal(f.plays[0].settings.restart,true);
    assert.deepEqual(f.events,['speak','saved'],'start reading within the answer gesture, before awaiting persistence');
    await f.run(`choose(${index})`);
    assert.equal(f.plays.length,1,'duplicate answer events do not read twice');
  }
});
test('quiz rating corrections replay only after the original answer',async()=>{
  for(const direction of ['ko','zh'])for(const rating of ['hard','again']){
    const f=fixture();prepareQuiz(f,direction);
    await f.run('choose(0)');await f.run(`correctQuizRating('${rating}')`);
    assert.equal(f.plays.length,2);
    assert.ok(f.plays.every(play=>play.request.text==='친구'));
  }
});
test('study to choice transition and next choice question stay silent',async()=>{
  const f=fixture();prepareQuiz(f,'ko');
  f.run("tab='study';studyCards=[testWord];renderStudyCard()");
  await f.run("assessStudy('known')");assert.equal(f.plays.length,2);
  clickHandler(f,'#next-study');
  assert.equal(f.run('tab'),'quiz');assert.equal(f.plays.length,2,'starting choices does not read the answer');
  await f.run('choose(0)');assert.equal(f.plays.length,3);
  clickHandler(f,'#next-question');
  assert.equal(f.run('session.index'),1);assert.equal(f.run('answered'),false);
  assert.equal(f.plays.length,3,'advancing to the next choice does not read its answer');
  await f.run('choose(0)');assert.equal(f.plays.length,4);
});
test('direct review stays silent on entry and pronounces only after answers in both directions',async()=>{
  const f=fixture();prepareQuiz(f,'ko');
  await f.run("startPractice([testWord],'到期复习',{direct:true})");
  assert.equal(f.run('tab'),'quiz');assert.equal(f.node('#quiz-label').textContent,'到期复习');
  assert.equal(f.plays.length,0);
  assert.equal(f.run('session.queue[session.index].direction'),'ko');
  await f.run('choose(0)');assert.equal(f.plays.length,1);
  clickHandler(f,'#next-question');
  assert.equal(f.run('session.queue[session.index].direction'),'zh');assert.equal(f.plays.length,1);
  await f.run('choose(-1)');assert.equal(f.plays.length,2);
  assert.ok(f.plays.every(play=>play.request.text==='친구'));
});
test('option and unknown button handlers each trigger one answer pronunciation',async()=>{
  for(const selector of ['#answer-options','#unknown-answer']){
    const f=fixture();prepareQuiz(f,'ko');
    clickHandler(f,selector,{target:{closest:selector=>selector==='[data-option]'?{dataset:{option:'0'}}:null}});
    await Promise.resolve();
    assert.equal(f.plays.length,1);assert.equal(f.plays[0].request.text,'친구');
  }
});
test('disabling automatic audio leaves study and both quiz directions usable without automatic playback',async()=>{
  const f=fixture('off');f.run('renderStudyCard()');await f.run("assessStudy('known')");assert.equal(f.plays.length,0);
  assert.ok(f.events.includes('saved'));
  for(const direction of ['ko','zh']){
    const q=fixture('off');prepareQuiz(q,direction);await q.run('choose(0)');
    await q.run("correctQuizRating('hard')");assert.equal(q.plays.length,0);assert.deepEqual(q.events,['saved','saved']);
  }
});
test('manual pronunciation remains available before and after a choice, even with automatic audio disabled',async()=>{
  for(const direction of ['ko','zh']){
    const f=fixture('off');prepareQuiz(f,direction);
    const button=f.node('[data-speak="quiz-word"]');button.dataset.speak='quiz-word';
    const event={target:{closest:selector=>selector==='[data-speak]'?button:null}};
    clickHandler(f,'document',event);assert.equal(f.plays.length,1);assert.equal(f.plays[0].settings.automatic,undefined);
    await f.run('choose(0)');assert.equal(f.plays.length,1);
    clickHandler(f,'document',event);assert.equal(f.plays.length,2);
    assert.ok(f.plays.every(play=>play.request.text==='친구'));
  }
});
test('study-start gesture unlocks synchronously before asynchronous preparation',()=>{
  const f=fixture();const capture=f.listeners.find(item=>item.selector==='document'&&item.type==='click'&&item.capture===true);
  assert.ok(capture);capture.fn({target:{closest:selector=>selector.includes('#start-next')?{}:null}});
  assert.deepEqual(f.events,['unlock']);assert.equal(f.plays.length,0);
});
