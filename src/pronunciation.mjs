// Call unlock() in the original study-start click, before its first await.
// WebKit removes its speech-start gesture restriction inside speak(); a silent
// primer is only an unlock attempt, never evidence that a Korean voice works.
export function createKoreanSpeech({synth,Utterance,offlineOnly=true,onState=()=>{},onMessage=()=>{},setTimer=setTimeout,clearTimer=clearTimeout,startTimeout=3500}={}) {
  let voices=[],active=null,failedVoice=null,primer=null;
  const voiceKey=voice=>voice?String(voice.voiceURI||voice.name||'')+'|'+String(voice.lang||''):null;
  function refreshVoices(){
    try{voices=synth?.getVoices()||[];}catch{if(offlineOnly)voices=[];}
  }
  function voicesChanged(){voices=[];failedVoice=null;refreshVoices();}
  refreshVoices();synth?.addEventListener?.('voiceschanged',voicesChanged);
  function chooseVoice(){
    const korean=voices.filter(voice=>voiceKey(voice)!==failedVoice&&/^ko(?:[-_]|$)/i.test(voice.lang||'')&&(!offlineOnly||voice.localService===true));
    return korean.find(voice=>voice.localService===true&&/^ko[-_]kr$/i.test(voice.lang))||korean.find(voice=>voice.localService===true)||korean[0];
  }
  function unlock(){
    if(!synth||!Utterance)return false;
    refreshVoices();
    const voice=chooseVoice();
    // Even an empty, silent utterance can make the engine fetch a network voice.
    if(offlineOnly&&!voice)return false;
    // An active utterance already used speak(); do not interrupt it to prime.
    if(active||primer)return true;
    const utterance=new Utterance('');utterance.lang='ko-KR';utterance.volume=0;
    if(voice)utterance.voice=voice;
    primer=utterance;
    utterance.onend=utterance.onerror=()=>{if(primer===utterance)primer=null;};
    try{if(synth.paused)synth.resume();synth.speak(utterance);return true;}
    catch{primer=null;return false;}
  }
  function finish(run){
    if(active!==run)return false;
    clearTimer(run.timer);active=null;onState('idle',run.target);return true;
  }
  function stop(){
    const run=active,hadPrimer=Boolean(primer);primer=null;
    if(run)finish(run);
    // Avoid cancel() on an idle engine; older Safari can lose the next utterance.
    if(synth&&(run||hadPrimer||synth.speaking||synth.pending))try{synth.cancel();}catch{}
  }
  function fail(run,message,code){if(finish(run))onMessage(message,run.target,{code});}
  function speak(text,target,{restart=false}={}){
    if(!synth||!Utterance){onMessage('当前浏览器无法朗读韩语，请换用设备自带的浏览器。',target,{code:'unsupported'});return false;}
    text=String(text||'').trim();if(!text)return false;
    if(active?.target===target&&active.text===text&&!restart){stop();return true;}
    stop();refreshVoices();
    const voice=chooseVoice();
    if(offlineOnly&&!voice){onMessage('设备还没有可用的离线韩语声音。请在系统设置中下载韩语语音，完成后重新打开本页。',target,{code:'local-voice-unavailable'});return false;}
    const utterance=new Utterance(text);
    utterance.lang='ko-KR';utterance.rate=0.85;utterance.volume=1;
    // Language matching without an explicit local voice is allowed only by opt-in.
    if(voice)utterance.voice=voice;
    const run={utterance,target,text,timer:null};active=run;
    onState('loading',target);
    utterance.onstart=()=>{
      if(active!==run)return;
      clearTimer(run.timer);onState('playing',target);
      run.timer=setTimer(()=>{if(active!==run)return;stop();onMessage('朗读未能完成，请再点一次发音按钮。',target,{code:'completion-timeout'});},Math.max(30000,Math.min(120000,text.length*700)));
    };
    utterance.onend=()=>finish(run);
    utterance.onerror=event=>{
      if(active!==run)return;
      if(['canceled','interrupted'].includes(event.error)){finish(run);return;}
      if(event.error==='voice-unavailable')failedVoice=voiceKey(voice);
      const unavailable=['language-unavailable','voice-unavailable','synthesis-unavailable'].includes(event.error);
      fail(run,unavailable?'设备暂时没有可用的韩语声音。请在系统设置中下载韩语语音，再打开本页。':'朗读没有启动，请再点一次发音按钮。',event.error);
    };
    run.timer=setTimer(()=>{
      if(active!==run)return;
      stop();onMessage('声音没有启动。请点击发音按钮；仍无声时检查设备音量，并在系统设置中下载韩语语音。',target,{code:'start-timeout'});
    },startTimeout);
    try{
      if(synth.paused)synth.resume();
      synth.speak(utterance);
    }catch{fail(run,'当前浏览器未能启动朗读，请再点一次发音按钮。','synthesis-failed');return false;}
    return true;
  }
  function available(localOnly=offlineOnly){refreshVoices();return voices.some(voice=>voiceKey(voice)!==failedVoice&&/^ko(?:[-_]|$)/i.test(voice.lang||'')&&(!localOnly||voice.localService===true));}
  return {speak,stop,unlock,available,localAvailable:()=>available(true),supported:()=>Boolean(synth&&Utterance),destroy(){stop();synth?.removeEventListener?.('voiceschanged',voicesChanged);}};
}
