import {createKoreanSpeech} from './pronunciation.mjs';
import {createRecordedAudio,isDictionaryRecording} from './recorded-audio.mjs';

// Offline playback uses only an explicitly installed Korean system voice.
// Network recordings and voices require an explicit offlineOnly: false opt-in.
// unlock() must run synchronously in the start click, before asynchronous lookup.
export function createWordAudio({Audio,synth,Utterance,offlineOnly=true,onState=()=>{},onFailure=()=>{},setTimer,clearTimer,recordingTimeout=3500,speechTimeout=3500}={}) {
  let current=null;
  const hasRecording=request=>Boolean(!offlineOnly&&Audio&&isDictionaryRecording(request.recording));
  function state(source,value,target){
    if(current?.source!==source||current.target!==target)return;
    onState(value,target);
  }
  function failure(source,message,target,detail={}){
    if(current?.source!==source||current.target!==target)return;
    const alternative=source==='recording'?(speech.supported()?'device':null):(hasRecording(current)?'recording':null);
    onFailure({source,message,target,alternative,automatic:Boolean(current.automatic),code:detail.code,localVoiceAvailable:speech.localAvailable(),deviceSupported:speech.supported()});
  }
  const speech=createKoreanSpeech({synth,Utterance,offlineOnly,setTimer,clearTimer,startTimeout:speechTimeout,onState:(value,target)=>state('device',value,target),onMessage:(message,target,detail)=>failure('device',message,target,detail)});
  const recordings=offlineOnly?null:createRecordedAudio({Audio,setTimer,clearTimer,loadTimeout:recordingTimeout,onState:(value,target)=>state('recording',value,target),onMessage:(message,target,detail)=>failure('recording',message,target,detail)});
  function stop(){recordings?.stop();speech.stop();current=null;}
  function play(request,preferred='auto',{restart=false,automatic=false}={}){
    // Never silently start an overseas recording from an automatic study event.
    const source=offlineOnly?'device':preferred==='auto'?(speech.supported()||automatic||!hasRecording(request)?'device':'recording'):preferred;
    if(current&&(current.source!==source||current.target!==request.target||current.text!==request.text))stop();
    current={...request,source,automatic};
    if(source==='device')speech.speak(request.text,request.target,{restart:restart||automatic});
    else if(!recordings.play(request.recording,request.target,{restart:restart||automatic}))failure('recording','这个词暂时没有可用的词典录音。',request.target,{code:'missing-recording'});
  }
  return {play,stop,unlock:()=>speech.unlock(),canSpeak:()=>speech.supported(),localVoiceAvailable:()=>speech.localAvailable(),destroy(){stop();speech.destroy();}};
}
