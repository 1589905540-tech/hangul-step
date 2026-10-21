import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecordedAudio} from '../src/recorded-audio.mjs';
const recording={url:'https://dicmedia.korean.go.kr/multimedia/sound_file/chieut_2005/chingu.wav'};
function fixture(){
  const audios=[],states=[],messages=[],timers=new Map();let timer=0;
  class Audio{constructor(){audios.push(this);}play(){this.playCalled=true;return Promise.resolve();}pause(){this.paused=true;}removeAttribute(name){this[name]='';}load(){this.loaded=true;}}
  const player=createRecordedAudio({Audio,onState:(state,target)=>states.push([state,target]),onMessage:message=>messages.push(message),setTimer:callback=>{timers.set(++timer,callback);return timer;},clearTimer:id=>timers.delete(id)});
  return {player,audios,states,messages,timers};
}
test('recorded audio starts synchronously and waits for playing before claiming playback',()=>{
  const f=fixture();assert.equal(f.player.play(recording,'word'),true);assert.equal(f.audios[0].src,recording.url);assert.equal(f.audios[0].playCalled,true);
  assert.deepEqual(f.states,[['loading','word']]);f.audios[0].onplaying();assert.deepEqual(f.states.at(-1),['playing','word']);f.audios[0].onended();assert.deepEqual(f.states.at(-1),['idle','word']);assert.equal(f.timers.size,0);
});
test('another tap stops; old callbacks cannot reset the next playback',()=>{
  const f=fixture();f.player.play(recording,'word');const first=f.audios[0];f.player.play(recording,'word');assert.equal(first.paused,true);assert.equal(f.audios.length,1);
  f.player.play(recording,'word');first.onended();first.onerror();assert.deepEqual(f.states.at(-1),['loading','word']);assert.equal(f.messages.length,0);
  f.player.stop();assert.equal(f.audios[1].paused,true);assert.equal(f.timers.size,0);
});
test('network errors and silent loading timeout reset the button and allow retry',()=>{
  const f=fixture();f.player.play(recording,'word');f.audios[0].onerror();assert.equal(f.messages.length,1);assert.equal(f.timers.size,0);
  f.player.play(recording,'word');[...f.timers.values()][0]();assert.equal(f.messages.length,2);assert.deepEqual(f.states.at(-1),['idle','word']);
});
test('a rejected play promise reports autoplay failure and does not claim playback',async()=>{
  const f=fixture();f.player.play(recording,'word');f.player.stop();
  const Audio=class{play(){return Promise.reject({name:'NotAllowedError'});}pause(){}removeAttribute(){}load(){}};
  const messages=[],states=[];const player=createRecordedAudio({Audio,onState:state=>states.push(state),onMessage:message=>messages.push(message)});
  player.play(recording,'word');await Promise.resolve();await Promise.resolve();assert.deepEqual(states,['loading','idle']);assert.match(messages[0],/再点一次/);
});
test('only original official media URLs can be played',()=>{
  const f=fixture();assert.equal(f.player.play({url:'https://evil.invalid/audio'},'word'),false);assert.equal(f.player.play(null,'word'),false);assert.equal(f.audios.length,0);
});

test('an explicit replay restarts the recording instead of toggling it off',()=>{
  const f=fixture();f.player.play(recording,'word');const first=f.audios[0];first.onplaying();
  f.player.play(recording,'word',{restart:true});assert.equal(first.paused,true);assert.equal(f.audios.length,2);
  assert.equal(f.audios[1].playCalled,true);first.onerror();first.onended();assert.equal(f.messages.length,0);
  assert.deepEqual(f.states.at(-1),['loading','word']);f.player.stop();assert.equal(f.timers.size,0);
});
