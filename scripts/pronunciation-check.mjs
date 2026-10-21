import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const browser=await chromium.launch({headless:true,channel:'msedge'});
const base=process.env.TEST_URL||'http://127.0.0.1:4178/';
const out=resolve(import.meta.dirname,'../artifacts');await mkdir(out,{recursive:true});
const errors=[];
try{
  const context=await browser.newContext({viewport:{width:375,height:568},isMobile:true,hasTouch:true});
  await context.addInitScript(()=>{
    const fake=new EventTarget();fake.voices=[];fake.paused=false;fake.speaking=false;fake.pending=false;
    fake.getVoices=()=>fake.voices;fake.calls=[];fake.cancels=0;
    fake.speak=utterance=>{fake.calls.push({utterance,userGesture:navigator.userActivation.isActive});};
    fake.cancel=()=>{fake.cancels++;};fake.resume=()=>{fake.paused=false;};
    Object.defineProperty(window,'speechSynthesis',{value:fake});
    Object.defineProperty(window,'SpeechSynthesisUtterance',{value:class{constructor(text){this.text=text;}}});
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  await page.goto(base);await page.locator('#learn-view').waitFor({state:'visible'});
  await page.evaluate(async()=>{const s=await(await fetch('/api/session')).json();const r=await fetch('/api/words',{method:'POST',headers:{'Content-Type':'application/json','X-Learning-Space':s.spaceId},body:JSON.stringify({items:[{korean:'새로운발음확인테스트',chinese:'发音验证示例'}]})});if(!r.ok)throw new Error(await r.text());});
  await page.reload();await page.locator('#learn-view').waitFor({state:'visible'});await page.locator('#start-next').click();
  const button=page.locator('[data-speak="study-word"]');
  await button.click();
  assert.equal(await button.getAttribute('data-audio'),'loading');
  assert.deepEqual(await page.evaluate(()=>({count:speechSynthesis.calls.length,lang:speechSynthesis.calls[0].utterance.lang,gesture:speechSynthesis.calls[0].userGesture,cancels:speechSynthesis.cancels})),{count:1,lang:'ko-KR',gesture:true,cancels:0});
  await page.evaluate(()=>speechSynthesis.calls[0].utterance.onstart());assert.equal(await button.getAttribute('data-audio'),'playing');
  await page.screenshot({path:resolve(out,'audio-playing-phone.png')});
  await button.click();assert.equal(await button.getAttribute('data-audio'),'idle');assert.equal(await page.evaluate(()=>speechSynthesis.calls.length),1);
  await button.click();await page.evaluate(()=>speechSynthesis.calls.at(-1).utterance.onerror({error:'voice-unavailable'}));
  await page.locator('#audio-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#audio-dictionary-link').count(),0,'Playback failure does not require leaving the app');
  assert.ok(await page.locator('#audio-error-message').innerText());
  for(const size of [{width:375,height:568},{width:844,height:390}]){
    await page.setViewportSize(size);
    for(const selector of ['#retry-audio']){const box=await page.locator(selector).boundingBox();assert.ok(box&&box.y>=0&&box.y+box.height<=size.height&&box.x>=0&&box.x+box.width<=size.width,selector+' must fit');}
  }
  await page.setViewportSize({width:375,height:568});await page.screenshot({path:resolve(out,'audio-fallback-phone.png')});
  await page.locator('#retry-audio').click();assert.equal(await page.locator('#audio-dialog').isVisible(),false);assert.equal(await page.evaluate(()=>speechSynthesis.calls.at(-1).userGesture),true);
  await page.evaluate(()=>{const last=speechSynthesis.calls.at(-1).utterance;last.onstart();last.onend();});assert.equal(await button.getAttribute('data-audio'),'idle');
  await button.click();await page.locator('#skip-study').click();
  assert.equal(await button.getAttribute('data-audio'),'idle');assert.equal(await page.locator('[data-speak="quiz-word"]').isDisabled(),true);
  const count=await page.evaluate(()=>speechSynthesis.calls.length);await page.locator('[data-speak="quiz-word"]').dispatchEvent('click');assert.equal(await page.evaluate(()=>speechSynthesis.calls.length),count);
  await page.locator('#unknown-answer').click();await page.locator('[data-speak="quiz-word"]').click();assert.equal(await page.evaluate(()=>speechSynthesis.calls.length),count+1);
  await page.evaluate(()=>speechSynthesis.calls.at(-1).utterance.onstart());await page.waitForFunction(()=>!document.querySelector('#next-question').disabled);await page.locator('#exit-quiz').click();await page.locator('#learn-view').waitFor({state:'visible'});assert.equal(await page.locator('[data-speak="quiz-word"]').getAttribute('data-audio'),'idle');
  await context.close();
  // Native engine probe is recorded separately: events cannot prove speaker audibility.
  const native=await browser.newPage({viewport:{width:390,height:844}});await native.goto(base);
  await native.setContent('<button id="native-speak">native engine probe</button>');
  await native.evaluate(()=>{
    window.probe={supported:!!window.speechSynthesis,events:[],voices:[]};
    document.querySelector('button').addEventListener('click',()=>{
      if(!window.speechSynthesis)return;
      window.probe.voices=speechSynthesis.getVoices().map(v=>v.lang);
      const u=new SpeechSynthesisUtterance('친구');u.lang='ko-KR';window.probeUtterance=u;
      u.onstart=()=>probe.events.push('start');u.onend=()=>probe.events.push('end');u.onerror=e=>probe.events.push('error:'+e.error);speechSynthesis.speak(u);
    });
  });
  await native.locator('button').click();await native.waitForTimeout(5500);
  const nativeProbe=await native.evaluate(()=>{speechSynthesis?.cancel();return probe;});
  assert.deepEqual(errors,[]);
  const report={status:'passed',integration:'mocked fallback speech engine for a word without dictionary audio',emptyListAttemptsSpeech:true,userGesturePreserved:true,loadingAndStartStates:true,repeatTapStops:true,errorsExposeInPageRetry:true,retryFitsSmallPortraitAndLandscape:true,answerGuardPreserved:true,navigationStops:true,nativeDesktopProbe:nativeProbe,physicalIOSVerified:false,pageErrors:errors};
  await writeFile(resolve(out,'pronunciation-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
