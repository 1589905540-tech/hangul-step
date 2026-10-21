export const isDictionaryRecording=recording=>Boolean(recording?.url&&/^https:\/\/dicmedia\.korean\.go\.kr\/multimedia\//.test(recording.url));
// Play original public dictionary recordings without a page jump.
export function createRecordedAudio({Audio,onState=()=>{},onMessage=()=>{},setTimer=setTimeout,clearTimer=clearTimeout,loadTimeout=3500}={}) {
  let active=null;
  function finish(run){
    if(active!==run)return false;
    active=null;clearTimer(run.timer);onState('idle',run.target);
    try{run.audio.pause();run.audio.removeAttribute('src');run.audio.load();}catch{}
    return true;
  }
  function stop(){if(active)finish(active);}
  function fail(run,message,code){if(finish(run))onMessage(message,run.target,{code});}
  function play(recording,target,{restart=false}={}){
    if(!isDictionaryRecording(recording)||!Audio)return false;
    if(active?.target===target&&!restart){stop();return true;}
    stop();
    const audio=new Audio(),run={audio,target,timer:null};active=run;
    audio.preload='auto';audio.volume=1;audio.playsInline=true;
    audio.onplaying=()=>{
      if(active!==run)return;
      clearTimer(run.timer);onState('playing',target);
      run.timer=setTimer(()=>fail(run,'录音未能播放完，请再试一次。','completion-timeout'),60000);
    };
    audio.onended=()=>finish(run);
    audio.onerror=()=>fail(run,'词典录音暂时连接不上，可改用设备朗读。','network-error');
    audio.src=recording.url;onState('loading',target);
    run.timer=setTimer(()=>fail(run,'词典录音连接较慢，可改用设备朗读。','load-timeout'),loadTimeout);
    // Do not await metadata or canplay before this call: keep the iOS click gesture.
    try{Promise.resolve(audio.play()).catch(error=>fail(run,error?.name==='NotAllowedError'?'声音未能启动，请再点一次发音按钮。':'录音暂时没有播放成功，请再试一次。',error?.name||'play-failed'));}
    catch{fail(run,'录音暂时没有播放成功，请再试一次。','play-failed');}
    return true;
  }
  return {play,stop};
}
