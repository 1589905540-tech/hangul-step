import test from 'node:test';
import assert from 'node:assert/strict';
import {createKoreanSpeech} from '../src/pronunciation.mjs';

function fixture({voices=[{lang:'ko-KR',localService:true}],offlineOnly=true}={}){
  const calls=[],states=[],messages=[],timers=new Map(),listeners=new Map();let timerId=0;
  class Utterance{constructor(text){this.text=text;}}
  const synth={voices,speaking:false,pending:false,paused:false,
    getVoices(){return this.voices;},addEventListener(name,handler){listeners.set(name,handler);},removeEventListener(name){listeners.delete(name);},
    cancel(){calls.push('cancel');},resume(){calls.push('resume');this.paused=false;},speak(utterance){calls.push(utterance);}};
  const controller=createKoreanSpeech({synth,Utterance,offlineOnly,onState:(state,target)=>states.push([state,target]),onMessage:(message,target,detail)=>messages.push({message,target,...detail}),setTimer:callback=>{timers.set(++timerId,callback);return timerId;},clearTimer:id=>timers.delete(id)});
  return {controller,synth,calls,states,messages,timers,listeners,Utterance};
}
test('offline mode never speaks or primes when its voice list is empty',()=>{
  const f=fixture({voices:[]});assert.equal(f.controller.unlock(),false);assert.equal(f.controller.speak('친구','word'),false);
  assert.equal(f.calls.length,0);assert.deepEqual(f.states,[]);assert.equal(f.timers.size,0);
  assert.equal(f.messages[0].code,'local-voice-unavailable');assert.match(f.messages[0].message,/下载韩语语音/);
});
test('offline mode rejects network Korean voices and voices without an explicit local flag',()=>{
  for(const voice of [{lang:'ko-KR',localService:false},{lang:'ko-KR'},{lang:'ko-KR',localService:'true'},{lang:'zh-CN',localService:true}]){
    const f=fixture({voices:[voice]});assert.equal(f.controller.available(),false);assert.equal(f.controller.unlock(),false);
    assert.equal(f.controller.speak('친구','word'),false);assert.equal(f.calls.length,0);assert.equal(f.timers.size,0);
    assert.equal(f.messages[0].code,'local-voice-unavailable');
  }
});
test('language matching without an installed voice is available only through explicit network opt-in',()=>{
  const f=fixture({voices:[],offlineOnly:false});f.controller.speak('친구','word');
  assert.equal(f.calls[0].lang,'ko-KR');assert.equal(f.calls[0].voice,undefined);f.controller.destroy();
});
test('voiceschanged makes a newly downloaded Korean voice available; resume stays synchronous',()=>{
  const f=fixture({voices:[]}),voice={lang:'ko-KR',localService:true};
  assert.equal(f.controller.speak('친구','word'),false);
  f.synth.voices=[{lang:'zh-CN'},voice];f.listeners.get('voiceschanged')();f.synth.paused=true;
  f.controller.speak('사과','word');assert.equal(f.calls[0],'resume');assert.equal(f.calls[1].voice,voice);
});
test('playing state requires onstart, ends cleanly, and keeps replay available',()=>{
  const f=fixture();f.controller.speak('친구','word');const first=f.calls[0];
  first.onstart();assert.deepEqual(f.states.at(-1),['playing','word']);assert.equal(f.timers.size,1);
  first.onend();assert.deepEqual(f.states.at(-1),['idle','word']);assert.equal(f.timers.size,0);
  f.controller.speak('친구','word');assert.equal(f.calls.length,2);assert.ok(!f.calls.includes('cancel'));
});
test('withdrawn and failed voices cannot trigger a language-only network fallback',()=>{
  const f=fixture(),voice={lang:'ko-KR',localService:true};f.synth.voices=[voice];f.listeners.get('voiceschanged')();
  f.controller.speak('친구','word');f.calls.at(-1).onerror({error:'voice-unavailable'});
  assert.equal(f.controller.speak('친구','word'),false);assert.equal(f.calls.length,1);
  f.synth.voices=[];f.listeners.get('voiceschanged')();assert.equal(f.controller.speak('친구','word'),false);assert.equal(f.calls.length,1);
});
test('silent start times out with feedback and a fresh click can retry',()=>{
  const f=fixture();f.controller.speak('친구','word');const first=f.calls[0];[...f.timers.values()][0]();
  assert.equal(f.messages.length,1);assert.match(f.messages[0].message,/没有启动/);assert.equal(f.calls.at(-1),'cancel');assert.deepEqual(f.states.at(-1),['idle','word']);
  f.controller.speak('친구','word');const second=f.calls.at(-1);first.onstart();first.onerror({error:'synthesis-failed'});
  assert.deepEqual(f.states.at(-1),['loading','word']);assert.equal(f.messages.length,1);second.onstart();assert.deepEqual(f.states.at(-1),['playing','word']);
});
test('repeat tap stops instead of queuing; cancellation errors are silent',()=>{
  const f=fixture();f.controller.speak('친구','word');const first=f.calls[0];f.controller.speak('친구','word');
  assert.equal(f.calls.at(-1),'cancel');assert.equal(f.calls.filter(x=>x instanceof f.Utterance).length,1);
  first.onerror({error:'canceled'});assert.deepEqual(f.messages,[]);assert.equal(f.timers.size,0);
});
test('switching words cancels old playback and ignores old callbacks',()=>{
  const f=fixture();f.controller.speak('친구','word');const first=f.calls[0];f.controller.speak('저는 친구를 만나요.','sentence');const second=f.calls.at(-1);
  first.onend();first.onerror({error:'voice-unavailable'});assert.deepEqual(f.states.at(-1),['loading','sentence']);assert.deepEqual(f.messages,[]);
  second.onstart();f.controller.stop();assert.deepEqual(f.states.at(-1),['idle','sentence']);assert.equal(f.timers.size,0);
  second.onstart();assert.deepEqual(f.states.at(-1),['idle','sentence']);
});
test('unavailable voice and thrown synthesis fail visibly without claiming playing',()=>{
  const f=fixture();f.controller.speak('친구','word');f.calls[0].onerror({error:'language-unavailable'});
  assert.match(f.messages[0].message,/韩语声音/);assert.ok(!f.states.some(([state])=>state==='playing'));assert.equal(f.timers.size,0);
  f.synth.speak=()=>{throw new Error('unavailable');};f.controller.speak('친구','word');assert.equal(f.messages.length,2);assert.deepEqual(f.states.at(-1),['idle','word']);
});
test('unsupported engine explains failure and destroy removes listener',()=>{
  const messages=[];createKoreanSpeech({onMessage:message=>messages.push(message)}).speak('친구','word');assert.match(messages[0],/无法朗读/);
  const f=fixture();f.controller.speak('친구','word');f.controller.destroy();assert.equal(f.listeners.size,0);assert.equal(f.timers.size,0);
});

test('local availability distinguishes installed Korean voices and refreshes after voice changes',()=>{
  const f=fixture({voices:[]});assert.equal(f.controller.localAvailable(),false);
  f.synth.voices=[{lang:'zh-CN',localService:true},{lang:'ko-KR',localService:false}];
  f.listeners.get('voiceschanged')();assert.equal(f.controller.available(),false);assert.equal(f.controller.available(false),true);assert.equal(f.controller.localAvailable(),false);
  const local={lang:'ko_KR',localService:true};f.synth.voices.push(local);f.listeners.get('voiceschanged')();
  assert.equal(f.controller.localAvailable(),true);f.controller.speak('친구','word');assert.equal(f.calls[0].voice,local);
  f.calls[0].onerror({error:'voice-unavailable'});assert.equal(f.controller.localAvailable(),false);
  f.synth.voices=[];f.listeners.get('voiceschanged')();assert.equal(f.controller.available(),false);
});

test('study-start unlock is synchronous and silent, and does not claim that a voice played',()=>{
  const f=fixture();assert.equal(f.controller.unlock(),true);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].text,'');assert.equal(f.calls[0].volume,0);
  assert.deepEqual(f.states,[]);assert.deepEqual(f.messages,[]);assert.equal(f.timers.size,0);
  f.controller.unlock();assert.equal(f.calls.length,1);
  const primer=f.calls[0];f.controller.speak('친구','word');
  assert.equal(f.calls[1],'cancel');assert.equal(f.calls[2].text,'친구');
  primer.onend();primer.onerror();assert.deepEqual(f.states,[['loading','word']]);
  f.calls[2].onstart();assert.deepEqual(f.states.at(-1),['playing','word']);
  f.controller.destroy();
});

test('rating replay restarts the current word, and changing text on the same button starts the new word',()=>{
  const f=fixture();f.controller.speak('친구','word');const first=f.calls[0];first.onstart();
  f.controller.speak('친구','word',{restart:true});const second=f.calls.at(-1);
  assert.notEqual(second,first);assert.equal(second.text,'친구');assert.equal(f.calls.filter(call=>call==='cancel').length,1);
  first.onend();first.onerror({error:'synthesis-failed'});assert.equal(f.messages.length,0);
  assert.deepEqual(f.states.at(-1),['loading','word']);
  f.controller.speak('학교','word');assert.equal(f.calls.at(-1).text,'학교');f.controller.stop();
});

test('failed Korean voice identity remains excluded when the browser returns fresh voice objects',()=>{
  const f=fixture();f.synth.voices=[{lang:'ko-KR',name:'Korean',voiceURI:'ko-local',localService:true}];
  f.controller.speak('친구','word');f.calls[0].onerror({error:'voice-unavailable'});
  f.synth.voices=[{lang:'ko-KR',name:'Korean',voiceURI:'ko-local',localService:true}];
  assert.equal(f.controller.localAvailable(),false);assert.equal(f.controller.speak('친구','word'),false);
  assert.equal(f.calls.length,1);f.controller.stop();
});

test('an empty refreshed voice list invalidates a previously installed voice before speaking',()=>{
  const f=fixture();assert.equal(f.controller.localAvailable(),true);f.synth.voices=[];
  assert.equal(f.controller.unlock(),false);assert.equal(f.controller.speak('친구','word'),false);assert.equal(f.calls.length,0);
});

test('unlock is unavailable without speech and never interrupts an already playing utterance',()=>{
  assert.equal(createKoreanSpeech().unlock(),false);
  const f=fixture();f.controller.speak('친구','word');f.calls[0].onstart();f.controller.unlock();
  assert.equal(f.calls.length,1);assert.deepEqual(f.states.at(-1),['playing','word']);f.controller.stop();
});
