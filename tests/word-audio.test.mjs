import test from 'node:test';
import assert from 'node:assert/strict';
import {createWordAudio} from '../src/word-audio.mjs';

const recording={url:'https://dicmedia.korean.go.kr/multimedia/sound_file/chieut_2005/chingu.wav'};
const request={text:'친구',target:'word',recording};
function fixture(voices=[{lang:'ko-KR',localService:true}],supported=true,{offlineOnly=true}={}){
  const audios=[],spoken=[],states=[],failures=[],timers=new Map(),listeners=new Map();let timer=0,cancels=0;
  class Audio{constructor(){audios.push(this);}play(){this.playCalled=true;return Promise.resolve();}pause(){this.paused=true;}removeAttribute(name){this[name]='';}load(){}}
  class Utterance{constructor(text){this.text=text;}}
  const synth={voices,getVoices(){return this.voices;},addEventListener:(name,callback)=>listeners.set(name,callback),removeEventListener:name=>listeners.delete(name),speak:utterance=>spoken.push(utterance),cancel(){cancels++;}};
  const player=createWordAudio({Audio,synth:supported?synth:null,Utterance:supported?Utterance:null,offlineOnly,
    onState:(state,target)=>states.push([state,target]),onFailure:failure=>failures.push(failure),
    setTimer:(callback,delay)=>{timers.set(++timer,{callback,delay});return timer;},clearTimer:id=>timers.delete(id)});
  return {player,synth,listeners,audios,spoken,states,failures,timers,cancels:()=>cancels};
}

test('installed Korean voice starts synchronously without creating a network audio player',()=>{
  const voice={lang:'ko-KR',localService:true},f=fixture([voice]);
  f.player.play(request);assert.equal(f.spoken[0].text,'친구');assert.equal(f.spoken[0].voice,voice);
  assert.equal(f.audios.length,0);assert.deepEqual(f.states,[['loading','word']]);
  f.spoken[0].onstart();assert.deepEqual(f.states.at(-1),['playing','word']);
  f.spoken[0].onend();assert.deepEqual(f.states.at(-1),['idle','word']);assert.equal(f.timers.size,0);
});

test('explicit network opt-in permits recording playback with a 3.5 second loading limit',()=>{
  const f=fixture([{lang:'ko-KR',localService:false}],true,{offlineOnly:false});assert.equal(f.player.localVoiceAvailable(),false);f.player.play(request,'recording');
  assert.equal(f.spoken.length,0);assert.equal(f.audios[0].playCalled,true);
  const timer=[...f.timers.values()][0];assert.equal(timer.delay,3500);timer.callback();
  assert.equal(f.failures[0].source,'recording');assert.equal(f.failures[0].alternative,'device');
  assert.equal(f.failures[0].localVoiceAvailable,false);assert.equal(f.audios[0].paused,true);
  assert.equal(f.spoken.length,0);assert.equal(f.timers.size,0);
});

test('recording failure waits for a fresh gesture to switch and later playback returns to device speech',()=>{
  const f=fixture(undefined,true,{offlineOnly:false});f.player.play(request,'recording');const recordingPlayer=f.audios[0];recordingPlayer.onerror();
  assert.equal(f.failures.length,1);assert.equal(f.spoken.length,0);
  f.player.play(request,f.failures[0].alternative);assert.equal(f.spoken[0].lang,'ko-KR');
  recordingPlayer.onerror();recordingPlayer.onplaying();assert.equal(f.failures.length,1);
  assert.deepEqual(f.states.at(-1),['loading','word']);
  f.spoken[0].onstart();f.spoken[0].onend();
  f.player.play({...request,text:'학교'});assert.equal(f.spoken.length,2);assert.equal(f.audios.length,1);
  f.player.stop();
});

test('device failure offers recording only in the explicitly enabled network mode',()=>{
  const f=fixture([{lang:'ko-KR',localService:true}],true,{offlineOnly:false});f.player.play(request);const utterance=f.spoken[0];
  utterance.onerror({error:'voice-unavailable'});
  assert.equal(f.failures[0].alternative,'recording');assert.equal(f.failures[0].localVoiceAvailable,false);
  assert.equal(f.audios.length,0);f.player.play(request,f.failures[0].alternative);
  assert.equal(f.audios[0].playCalled,true);utterance.onend();utterance.onerror({error:'synthesis-failed'});
  assert.deepEqual(f.states.at(-1),['loading','word']);assert.equal(f.failures.length,1);f.player.stop();
});

test('repeat tap stops, switching targets resets the old button, and stopped callbacks cannot show failure',()=>{
  const f=fixture([{lang:'ko-KR',localService:true}]);f.player.play(request);f.player.play(request);
  assert.equal(f.spoken.length,1);assert.equal(f.cancels(),1);assert.equal(f.timers.size,0);
  f.player.play(request);const old=f.spoken[1];f.player.play({...request,text:'안녕하세요',target:'sentence',recording:null});
  assert.deepEqual(f.states.slice(-2),[['idle','word'],['loading','sentence']]);
  old.onstart();old.onerror({error:'synthesis-failed'});assert.equal(f.failures.length,0);
  f.player.stop();f.spoken.at(-1).onerror({error:'synthesis-failed'});assert.equal(f.failures.length,0);
  assert.deepEqual(f.states.at(-1),['idle','sentence']);assert.equal(f.timers.size,0);
});

test('a sentence without recording tries device speech and never offers a nonexistent alternative',()=>{
  const f=fixture();f.player.play({...request,recording:null});
  assert.equal(f.spoken.length,1);f.spoken[0].onerror({error:'language-unavailable'});
  assert.equal(f.failures[0].alternative,null);assert.equal(f.audios.length,0);
});

test('network opt-in on unsupported speech does not offer a device button that cannot work',()=>{
  const f=fixture([],false,{offlineOnly:false});f.player.play(request);f.audios[0].onerror();
  assert.equal(f.failures[0].alternative,null);assert.equal(f.failures[0].deviceSupported,false);
  f.player.play({...request,recording:null});assert.match(f.failures[1].message,/无法朗读/);
});

test('offline mode with no installed voice shows download guidance without starting speech or audio',()=>{
  const f=fixture([]);assert.equal(f.player.canSpeak(),true);assert.equal(f.player.unlock(),false);f.player.play(request);
  assert.equal(f.spoken.length,0);assert.equal(f.audios.length,0);assert.equal(f.timers.size,0);
  assert.equal(f.failures[0].code,'local-voice-unavailable');assert.match(f.failures[0].message,/下载韩语语音/);
  assert.equal(f.failures[0].alternative,null);assert.equal(f.failures[0].automatic,false);
});

test('automatic reveal and rating events restart once each, with distinct failure context and no network fallback',()=>{
  const f=fixture([{lang:'ko-KR',localService:true}]);f.player.play(request,'auto',{automatic:true});const first=f.spoken[0];
  first.onstart();f.player.play(request,'auto',{automatic:true});assert.equal(f.spoken.length,2);assert.equal(f.cancels(),1);
  first.onerror({error:'synthesis-failed'});assert.equal(f.failures.length,0);
  f.spoken[1].onerror({error:'voice-unavailable'});assert.equal(f.failures[0].automatic,true);
  assert.equal(f.failures[0].code,'voice-unavailable');assert.equal(f.failures[0].alternative,null);
  assert.equal(f.audios.length,0);assert.equal(f.timers.size,0);
});

test('automatic study never silently switches to a network recording on an unsupported device',()=>{
  const f=fixture([],false);f.player.play(request,'auto',{automatic:true});
  assert.equal(f.audios.length,0);assert.equal(f.spoken.length,0);assert.equal(f.failures[0].automatic,true);
  assert.equal(f.failures[0].code,'unsupported');assert.equal(f.failures[0].alternative,null);
});

test('offline mode ignores a previously selected recording preference and reads with its installed voice',()=>{
  const voice={lang:'ko-KR',localService:true},f=fixture([voice]);f.player.play(request,'recording');
  assert.equal(f.spoken[0].voice,voice);assert.equal(f.audios.length,0);assert.equal(f.failures.length,0);f.player.destroy();
});

test('offline manual and automatic events never fall through to network-only voices or recordings',()=>{
  const f=fixture([{lang:'ko-KR',localService:false}]);assert.equal(f.player.unlock(),false);
  for(const preferred of ['auto','device','recording'])for(const automatic of [false,true])f.player.play(request,preferred,{automatic});
  assert.equal(f.spoken.length,0);assert.equal(f.audios.length,0);assert.equal(f.timers.size,0);assert.equal(f.failures.length,6);
  assert.ok(f.failures.every(failure=>failure.code==='local-voice-unavailable'&&failure.alternative===null));
  assert.deepEqual(f.failures.map(failure=>failure.automatic),[false,true,false,true,false,true]);
});

test('a later voiceschanged event makes a downloaded local voice usable without reloading the player',()=>{
  const f=fixture([]);f.player.play(request,'auto',{automatic:true});assert.equal(f.spoken.length,0);
  const voice={lang:'ko-KR',localService:true};f.synth.voices=[voice];f.listeners.get('voiceschanged')();
  assert.equal(f.player.localVoiceAvailable(),true);assert.equal(f.player.unlock(),true);
  f.player.play(request,'auto',{automatic:true});assert.equal(f.spoken.at(-1).voice,voice);
  assert.equal(f.spoken.at(-1).text,request.text);assert.equal(f.audios.length,0);f.player.destroy();
});

test('offline playback is the public default when offlineOnly is omitted',()=>{
  const spoken=[],failures=[];let audioCount=0;
  class Audio{constructor(){audioCount++;}}
  class Utterance{constructor(text){this.text=text;}}
  const player=createWordAudio({Audio,Utterance,synth:{getVoices:()=>[{lang:'ko-KR',localService:false}],speak:utterance=>spoken.push(utterance)},onFailure:failure=>failures.push(failure)});
  assert.equal(player.unlock(),false);player.play(request,'recording');
  assert.equal(spoken.length,0);assert.equal(audioCount,0);assert.equal(failures[0].alternative,null);player.destroy();
});

test('word player exposes synchronous study-start unlock without setting a playing state',()=>{
  const f=fixture();assert.equal(f.player.unlock(),true);assert.equal(f.spoken[0].text,'');
  assert.equal(f.spoken[0].volume,0);assert.deepEqual(f.states,[]);assert.deepEqual(f.failures,[]);
  f.player.stop();f.player.play(request,'auto',{automatic:true});assert.equal(f.spoken.at(-1).text,'친구');
  f.player.destroy();assert.equal(f.timers.size,0);
});

test('a WebKit-style session restriction is unlocked before asynchronous card preparation',async()=>{
  const timers=new Map(),states=[],spoken=[];let gesture=false,allowed=false,timerId=0;
  class Utterance{constructor(text){this.text=text;}}
  const synth={getVoices:()=>[{lang:'ko-KR',localService:true}],cancel(){},speak(utterance){
    // Model WebKit's synchronous gesture check; this is not an iPad device test.
    if(gesture)allowed=true;if(!allowed)return;
    spoken.push(utterance.text);utterance.onstart?.();if(!utterance.text)utterance.onend?.();
  }};
  const player=createWordAudio({synth,Utterance,onState:state=>states.push(state),
    setTimer:callback=>{timers.set(++timerId,callback);return timerId;},clearTimer:id=>timers.delete(id)});
  gesture=true;player.unlock();gesture=false;
  await Promise.resolve();player.stop();player.play(request,'auto',{automatic:true});
  assert.deepEqual(spoken,['','친구']);assert.equal(states.at(-1),'playing');player.destroy();
});
