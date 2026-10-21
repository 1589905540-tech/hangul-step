import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const browser=await chromium.launch({headless:true,channel:'msedge'});
const out=resolve(import.meta.dirname,'../artifacts');await mkdir(out,{recursive:true});
const base=process.env.TEST_URL||'http://127.0.0.1:4178/';
const errors=[],responses=[];
try{
  const context=await browser.newContext({viewport:{width:375,height:568},isMobile:true,hasTouch:true});
  await context.addInitScript(()=>{
    Object.defineProperty(window,'speechSynthesis',{value:undefined});Object.defineProperty(window,'SpeechSynthesisUtterance',{value:undefined});
    const NativeAudio=window.Audio;window.audioLog=[];window.audioPlayers=[];
    window.Audio=function(...args){
      const audio=new NativeAudio(...args),id=audioPlayers.length;audioPlayers.push(audio);
      const play=audio.play.bind(audio);
      audio.play=function(){audioLog.push({id,event:'play',url:audio.src,gesture:navigator.userActivation.isActive});return play();};
      for(const event of ['playing','timeupdate','ended','error'])audio.addEventListener(event,()=>audioLog.push({id,event,time:audio.currentTime,duration:audio.duration,error:audio.error?.code}));
      return audio;
    };
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.url().startsWith('https://dicmedia.korean.go.kr/'))responses.push({url:r.url(),status:r.status(),type:r.headers()['content-type']});});
  await page.goto(base);await page.locator('#learn-view').waitFor({state:'visible'});
  await page.evaluate(async()=>{
    const s=await(await fetch('/api/session')).json();
    const r=await fetch('/api/words',{method:'POST',headers:{'Content-Type':'application/json','X-Learning-Space':s.spaceId},body:JSON.stringify({items:[{korean:'친구',chinese:'朋友'},{korean:'사과',chinese:'道歉'},{korean:'가치관',chinese:'价值观'}]})});if(!r.ok)throw new Error(await r.text());
  });
  await page.reload();await page.locator('#learn-view').waitFor({state:'visible'});
  const stored=await page.evaluate(async()=>await(await fetch('/api/words')).json());assert.ok(stored.words.every(w=>w.recording?.url));
  assert.equal(stored.words.find(w=>w.korean==='사과').recording.entryId,'15830');
  await page.locator('#start-next').click();
  for(let i=0;i<3;i++){
    await page.locator('[data-speak="study-word"]').click();
    await page.waitForFunction(index=>audioLog.some(e=>e.id===index&&e.event==='ended'),i,{timeout:25000});
    const log=await page.evaluate(index=>audioLog.filter(e=>e.id===index),i);
    assert.ok(log.some(e=>e.event==='play'&&e.gesture));assert.ok(log.some(e=>e.event==='playing'));assert.ok(log.some(e=>e.event==='timeupdate'&&e.time>0));assert.ok(!log.some(e=>e.event==='error'));
    assert.equal(await page.locator('[data-speak="study-word"]').getAttribute('data-audio'),'idle');
    assert.equal(new URL(page.url()).pathname,'/');assert.equal(context.pages().length,1);assert.equal(await page.locator('#audio-dialog').isVisible(),false);
    if(i<2){await page.locator('[data-confidence="known"]').click();await page.locator('#next-study').click();await page.waitForFunction(index=>document.querySelector('#study-counter').textContent===(index+1)+' / 3',i+1);}
  }
  await page.locator('[data-speak="study-word"]').click();await page.locator('#skip-study').click();
  assert.equal(await page.locator('[data-speak="study-word"]').getAttribute('data-audio'),'idle');
  assert.equal(await page.locator('[data-speak="quiz-word"]').isDisabled(),true);
  assert.equal(await page.locator('#audio-dictionary-link').count(),0);
  assert.deepEqual(errors,[]);assert.ok(responses.every(r=>[200,206].includes(r.status)));
  const report={status:'passed',systemSpeechDisabled:true,realAudioElement:true,originalRemoteRecordings:true,words:['친구','사과/道歉','가치관'],audioEvents:await page.evaluate(()=>audioLog),responses,noPageJump:true,answerGuardPreserved:true,navigationStops:true,physicalIOSVerified:false,pageErrors:errors};
  await writeFile(resolve(out,'recorded-audio-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,words:report.words,originalRemoteRecordings:true,systemSpeechDisabled:true,noPageJump:true,physicalIOSVerified:false,responses}));
}finally{await browser.close();}
