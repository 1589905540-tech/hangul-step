import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as core from '../src/core.mjs';

const source=(await readFile(new URL('../src/app.mjs',import.meta.url),'utf8'))
  .replace(/^import .*;\r?\n/gm,'').replace(/\ninit\(\);\s*$/,'');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

function fixture(t,{online=true,ready=true,updateFails=false,registrationExists=true,statusHandler,getRegistrationHandler,updateHandler}={}) {
  const nodes=new Map(),listeners=[],events=[],timers=new Set(),ports=[];
  let initialized=0,reads=0;
  function node(selector){
    if(!nodes.has(selector))nodes.set(selector,{
      dataset:{},style:{setProperty(){}},classList:{add(){},remove(){},toggle(){}},
      hidden:false,disabled:false,textContent:'',innerHTML:'',value:'',open:false,offsetWidth:100,scrollTop:0,
      setAttribute(){},getAttribute(){return '听韩文发音';},focus(){},append(){},replaceChildren(){},
      addEventListener(type,fn){listeners.push({selector,type,fn});},querySelector:node,
      showModal(){this.open=true;},close(){this.open=false;},
    });
    return nodes.get(selector);
  }
  const active={state:'activated',postMessage(message,[port]){
    events.push(message.type);
    const result=statusHandler?statusHandler(message.type):{ready};
    Promise.resolve(result).then(value=>port.postMessage({type:'SPRING_OFFLINE_STATUS',missing:[],...value}));
  }};
  const registration={active,installing:null,waiting:null,async update(){events.push('update');if(updateFails)throw new Error('deployment unavailable');if(updateHandler)await updateHandler();}};
  const serviceWorker={
    async getRegistration(scope){events.push('getRegistration:'+scope);return getRegistrationHandler?getRegistrationHandler(registration):(registrationExists?registration:undefined);},
    async register(path,options){events.push('register:'+path);assert.equal(options.scope,'/');return registration;},
  };
  class MessageChannel {
    constructor(){
      this.port1={closed:false,onmessage:null,close(){this.closed=true;}};
      const receiver=this.port1;
      this.port2={closed:false,postMessage(value){queueMicrotask(()=>{if(!receiver.closed)receiver.onmessage?.({data:value});});},close(){this.closed=true;}};
      ports.push(this.port1,this.port2);
    }
  }
  const state={spaceId:'local:existing',code:'SC-existing',words:[],isNew:false};
  const document={hidden:false,body:node('body'),documentElement:node('html'),
    querySelector:selector=>selector==='dialog[open]'?null:node(selector),querySelectorAll:()=>[],
    addEventListener(type,fn,capture){listeners.push({selector:'document',type,fn,capture});}};
  const navigator={onLine:online,serviceWorker,storage:{async persist(){events.push('persist');return true;}}};
  const context=vm.createContext({...core,DICTIONARY:[],EXAMPLES:{},document,navigator,MessageChannel,
    window:{isSecureContext:true,matchMedia:()=>({matches:true}),addEventListener(){},scrollTo(){}},
    innerHeight:850,innerWidth:1200,localStorage:{getItem:()=>null,setItem(){}},BroadcastChannel:undefined,
    crypto:globalThis.crypto,structuredClone,console,URL,AbortController,
    fetch:async()=>{events.push('fetch');throw new Error('Unexpected network request');},
    setTimeout:(fn,delay)=>{let timer;timer=setTimeout(()=>{timers.delete(timer);fn();},delay);timers.add(timer);return timer;},
    clearTimeout:timer=>{clearTimeout(timer);timers.delete(timer);},
    createLocalStore:()=>({async initialize(){initialized++;return state;},async read(){reads++;return state;}}),
    createOfflineLookup:()=>({}),
    createWordAudio:()=>({stop(){},localVoiceAvailable:()=>true}),
  });
  vm.runInContext(source,context);
  t.after(()=>{for(const timer of timers)clearTimeout(timer);for(const port of ports)port.close();});
  return {events,node,navigator,registration,active,timers,ports,
    reads:()=>reads,initialized:()=>initialized,run:code=>vm.runInContext(code,context),
    async clickPrepare(){const listener=listeners.find(item=>item.selector==='#prepare-offline'&&item.type==='click');assert.ok(listener);await listener.fn({target:node('#prepare-offline')});},
  };
}

test('startup opens the existing device wordbook without configuration or account requests',async t=>{
  const f=fixture(t);await f.run('init()');await flush();
  assert.equal(f.initialized(),1);assert.equal(f.reads(),1);
  assert.equal(f.node('#legacy-import').hidden,true);
  assert.equal(f.node('#load-status').hidden,true);
  assert.equal(f.node('#sync-status').textContent,'已保存在此设备');
  assert.ok(!f.events.includes('fetch'));
  assert.ok(!f.events.includes('update'));
  assert.ok(!f.events.some(event=>event.startsWith('register:')));
  assert.match(f.node('#offline-status').textContent,/已保存到本机/);
  assert.equal(f.timers.size,0);assert.ok(f.ports.every(port=>port.closed));
});

test('reopening a prepared edition only checks local cache health',async t=>{
  const f=fixture(t);await f.run('setupOffline()');
  assert.deepEqual(f.events,['getRegistration:/','SPRING_OFFLINE_STATUS','persist']);
  assert.match(f.node('#offline-status').textContent,/已保存到本机/);
  assert.equal(f.node('#prepare-offline').textContent,'检查更新');
  assert.equal(f.node('#prepare-offline').disabled,false);
});

test('an activated worker with missing cached resources is not reported as ready',async t=>{
  const f=fixture(t,{ready:false});await f.run('setupOffline()');
  assert.match(f.node('#offline-status').textContent,/资源不完整/);
  assert.doesNotMatch(f.node('#offline-status').textContent,/已保存/);
  assert.equal(f.node('#prepare-offline').textContent,'联网准备');
  assert.ok(!f.events.includes('SPRING_PREPARE_OFFLINE'));
  assert.ok(!f.events.includes('persist'));
});

test('manual preparation checks for an update and explicitly requests missing resources',async t=>{
  const f=fixture(t,{statusHandler:type=>({ready:type==='SPRING_PREPARE_OFFLINE'})});
  await f.clickPrepare();
  assert.deepEqual(f.events,['getRegistration:/','update','SPRING_OFFLINE_STATUS','SPRING_PREPARE_OFFLINE','persist']);
  assert.match(f.node('#offline-status').textContent,/已保存到本机/);
  assert.equal(f.node('#prepare-offline').disabled,false);
});

test('manual update on a healthy cache does not request another resource preparation',async t=>{
  const f=fixture(t);await f.clickPrepare();
  assert.deepEqual(f.events,['getRegistration:/','update','SPRING_OFFLINE_STATUS','persist']);
});

test('opening and manually checking while offline never registers or explicitly updates an existing worker',async t=>{
  const f=fixture(t,{online:false});await f.run('setupOffline()');await f.clickPrepare();
  assert.ok(!f.events.includes('update'));
  assert.ok(!f.events.some(event=>event.startsWith('register:')));
  assert.ok(!f.events.includes('SPRING_PREPARE_OFFLINE'));
  assert.match(f.node('#offline-status').textContent,/联网后可检查更新/);
});

test('a failed update retains a healthy active edition and releases the button',async t=>{
  const f=fixture(t,{updateFails:true});await f.clickPrepare();
  assert.deepEqual(f.events,['getRegistration:/','update','SPRING_OFFLINE_STATUS','persist']);
  assert.match(f.node('#offline-status').textContent,/当前版本可离线使用，更新尚未完成/);
  assert.equal(f.node('#prepare-offline').disabled,false);
  assert.equal(f.timers.size,0);
});

test('initial preparation registers the worker when this origin has no installation',async t=>{
  const f=fixture(t,{registrationExists:false});await f.run('setupOffline()');
  assert.deepEqual(f.events,['getRegistration:/','register:/service-worker.js','SPRING_OFFLINE_STATUS','persist']);
});

test('an older delayed check cannot overwrite the status from the latest setup',async t=>{
  const first=deferred();let statusCalls=0;
  const f=fixture(t,{online:false,statusHandler:()=>++statusCalls===1?first.promise:{ready:false}});
  const older=f.run('setupOffline(true)');await flush();
  await f.run('setupOffline(false)');
  const latest=f.node('#offline-status').textContent;
  first.resolve({ready:true});await older;
  assert.equal(f.node('#offline-status').textContent,latest);
  assert.match(latest,/资源不完整/);
  assert.equal(f.node('#prepare-offline').textContent,'联网准备');
});

test('a superseded manual check cannot start resource downloads after a newer check finishes',async t=>{
  const first=deferred();let statusCalls=0;
  const f=fixture(t,{statusHandler:()=>++statusCalls===1?first.promise:{ready:true}});
  const older=f.run('setupOffline(true)');await flush();
  await f.run('setupOffline(false)');
  const latest=f.node('#offline-status').textContent;
  first.resolve({ready:false});await older;
  assert.ok(!f.events.includes('SPRING_PREPARE_OFFLINE'));
  assert.equal(f.node('#offline-status').textContent,latest);
});

test('a superseded registration lookup cannot register a worker after a newer check finishes',async t=>{
  const first=deferred();let lookups=0;
  const f=fixture(t,{getRegistrationHandler:registration=>++lookups===1?first.promise:registration});
  const older=f.run('setupOffline()');await flush();
  await f.run('setupOffline()');
  const latest=f.node('#offline-status').textContent;
  first.resolve(undefined);await older;
  assert.ok(!f.events.some(event=>event.startsWith('register:')));
  assert.equal(f.node('#offline-status').textContent,latest);
});

test('a superseded update cannot initiate additional cache work when it resolves',async t=>{
  const first=deferred();const f=fixture(t,{updateHandler:()=>first.promise});
  const older=f.run('setupOffline(true)');await flush();
  await f.run('setupOffline()');
  const latestEvents=[...f.events],latest=f.node('#offline-status').textContent;
  first.resolve();await older;
  assert.deepEqual(f.events,latestEvents);
  assert.equal(f.node('#offline-status').textContent,latest);
});
