import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DICTIONARY} from '../src/dictionary.mjs';
const runtime=process.env.PLAYWRIGHT_MODULE;
if(!runtime)throw new Error('Set PLAYWRIGHT_MODULE to the installed playwright/index.mjs path.');
const {chromium}=await import(pathToFileURL(runtime));
const out=resolve(import.meta.dirname,'../artifacts');await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'msedge'});
const page=await browser.newPage({viewport:{width:1024,height:1366},isMobile:true,hasTouch:true});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
try{
  await page.goto(process.env.TEST_URL||'http://127.0.0.1:4178/');await page.locator('#learn-view').waitFor({state:'visible'});
  await page.screenshot({path:resolve(out,'ipad-home.png'),fullPage:true,animations:'disabled'});
  const background=await page.request.get(new URL('/coast-v1.webp',page.url()).href);assert.equal(background.status(),200);assert.match(background.headers()['content-type'],/image\/webp/);assert.equal((await background.body()).subarray(8,12).toString(),'WEBP');
  await page.locator('[data-tab="add"]').click();
  // The preview database belongs to this app only. Start from its current data;
  // never mutate a production Site or delete user records for a test.
  await page.locator('#lookup-input').fill('朋友');await page.locator('#lookup-button').click();
  await page.locator('#confirm-form').waitFor({state:'visible'});
  assert.equal(await page.locator('#korean-input').inputValue(),'친구');assert.equal(await page.locator('#chinese-input').inputValue(),'朋友');
  await page.screenshot({path:resolve(out,'ipad-lookup.png'),fullPage:true,animations:'disabled'});
  const hasFriend=await page.evaluate(async()=>{const r=await fetch('/api/words');return (await r.json()).words.some(w=>w.korean==='친구');});
  if(!hasFriend){await page.locator('#save-word-button').click();await page.locator('#confirm-form').waitFor({state:'hidden'});}
  const hasWords=await page.evaluate(async()=>{const r=await fetch('/api/words');return (await r.json()).words.length;});
  if(hasWords<10){await page.evaluate(async(items)=>{const s=await(await fetch('/api/session')).json();const r=await fetch('/api/words',{method:'POST',headers:{'Content-Type':'application/json','X-Learning-Space':s.spaceId},body:JSON.stringify({items})});if(!r.ok)throw new Error(await r.text());},DICTIONARY.slice(0,10).map(({korean,chinese})=>({korean,chinese})));await page.reload();await page.locator('#learn-view').waitFor({state:'visible'});}
  await page.locator('#start-next').click();await page.locator('#study-view').waitFor({state:'visible'});
  let cardCount=0;const difficult=[];
  while(await page.locator('#study-view').isVisible()) {
    assert.equal(await page.locator('#next-study').isDisabled(),true);
    assert.equal(await page.locator('#study-chinese').isVisible(),false);
    const cardWord=await page.locator('#study-korean').innerText();
    const counter=await page.locator('#study-counter').innerText();
    if(cardCount===0){await page.screenshot({path:resolve(out,'ipad-recall.png'),fullPage:true,animations:'disabled'});await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await page.screenshot({path:resolve(out,'phone-recall.png'),fullPage:true,animations:'disabled'});await page.setViewportSize({width:1024,height:1366});}
    const confidence=cardCount===1?'maybe':cardCount===2?'unknown':'known';
    await page.locator('[data-confidence="'+confidence+'"]').click();
    if(confidence!=='known')difficult.push(cardWord);
    if(cardCount===0){await page.locator('#study-wrong').focus();await page.keyboard.press('Enter');difficult.push(cardWord);assert.equal(await page.locator('#study-wrong').isDisabled(),true);assert.equal(await page.locator('#study-counter').innerText(),counter,'Enter on a button uses its action instead of jumping to the next card');}
    assert.equal(await page.locator('#study-chinese').innerText(),DICTIONARY.find(w=>w.korean===cardWord).chinese);
    if(cardCount===0){assert.equal(await page.locator('#study-details').isVisible(),true);await page.screenshot({path:resolve(out,'ipad-word-card.png'),fullPage:true,animations:'disabled'});await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(out,'phone-word-card.png'),fullPage:true,animations:'disabled'});await page.setViewportSize({width:1024,height:1366});}
    const unchanged=await page.evaluate(async()=>await(await fetch('/api/words')).json());assert.ok(unchanged.words.every(w=>!w.masteryKo&&!w.masteryZh&&w.reviewAt===null),'Self-rating does not save a correct answer');
    // Two immediate taps must advance only one card despite the exit animation.
    await page.evaluate(()=>{document.querySelector('#next-study').click();document.querySelector('#next-study').click();});
    await page.waitForFunction(old=>document.querySelector('#study-view').hidden||document.querySelector('#study-counter').textContent!==old,counter);
    cardCount++;assert.ok(cardCount<=10);
    if(cardCount<10)assert.equal(await page.locator('#study-counter').innerText(),(cardCount+1)+' / 10');
  }
  assert.equal(cardCount,10);await page.locator('#quiz-view').waitFor({state:'visible'});
  assert.equal(await page.locator('.answer-option').count(),4);
  assert.equal(await page.locator('[data-speak="quiz-word"]').isDisabled(),true,'Korean audio must not reveal a Chinese-to-Korean answer');
  assert.ok(difficult.map(korean=>DICTIONARY.find(w=>w.korean===korean).chinese).includes(await page.locator('#question').innerText()),'Difficult recall cards appear first');
  await page.screenshot({path:resolve(out,'ipad-quiz.png'),fullPage:true,animations:'disabled'});
  let questionCount=0,wrongInjected=false,retryOptionsChanged=false;const seenOptions=new Map();
  while(await page.locator('#quiz-view').isVisible()){
    const counter=await page.locator('#quiz-counter').innerText();
    const question=await page.locator('#question').innerText();const dir=await page.locator('#question-direction').innerText();
    const item=DICTIONARY.find(w=>dir.includes('选韩文')?w.chinese===question:w.korean===question);assert.ok(item,'Question matches a real vocabulary entry');
    const labels=await page.locator('.answer-option>span:last-child').allTextContents();const expected=dir.includes('选韩文')?item.korean:item.chinese;
    const correct=labels.indexOf(expected);assert.ok(correct>=0);assert.equal(new Set(labels).size,4);
    const key=question+':'+expected,previous=seenOptions.get(key);
    if(previous){assert.notDeepEqual([...labels].sort(),[...previous.labels].sort());assert.notEqual(correct,previous.correct);retryOptionsChanged=true;}
    seenOptions.set(key,{labels,correct});
    if(!wrongInjected){await page.locator('#unknown-answer').click();wrongInjected=true;}else await page.locator('.answer-option').nth(correct).click();
    await page.waitForFunction(()=>!document.querySelector('#next-question').disabled);
    assert.equal(await page.locator('#question').innerText(),item.korean);assert.equal(await page.locator('#quiz-chinese').innerText(),item.chinese);assert.equal(await page.locator('#answer-options').isVisible(),false);
    if(questionCount===0)await page.screenshot({path:resolve(out,'ipad-feedback.png'),fullPage:true,animations:'disabled'});
    await page.evaluate(()=>{document.querySelector('#next-question').click();document.querySelector('#next-question').click();});
    await page.waitForFunction(old=>document.querySelector('#quiz-view').hidden||document.querySelector('#quiz-counter').textContent!==old,counter);questionCount++;
    assert.ok(questionCount<=40,'Bounded wrong-answer retries');
  }
  assert.equal(questionCount,21);assert.equal(await page.locator('#result-score').innerText(),'19 / 20');assert.equal(await page.locator('#result-pending').innerText(),'0');
  assert.equal(retryOptionsChanged,true);
  await page.screenshot({path:resolve(out,'ipad-result.png'),fullPage:true,animations:'disabled'});
  await page.reload();await page.locator('#learn-view').waitFor({state:'visible'});await page.locator('[data-tab="words"]').click();assert.match(await page.locator('#group-picker option').first().innerText(),/10 \/ 10/);
  await page.locator('[data-tab="words"]').click();assert.equal(await page.locator('.word-row').count(),10);
  await page.locator('.word-actions [data-edit]').first().click();await page.locator('#edit-dialog').waitFor({state:'visible'});await page.locator('#edit-dialog [data-close-dialog]').click();
  // Simulate a response lost after the server committed an answer. A retry must
  // use the same answer ID and must never double-count the mistake.
  await page.locator('[data-tab="learn"]').click();await page.locator('#start-next').click();
  let savedId, retryId, intercepted=0;
  await page.route('**/api/answers',async route=>{
    const payload=route.request().postDataJSON();intercepted++;
    if(intercepted===1){savedId=payload.id;await route.fetch();await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'模拟保存响应丢失'})});}
    else{retryId=payload.id;await route.continue();}
  });
  await page.locator('.answer-option').first().click();await page.getByRole('button',{name:'重试保存',exact:true}).waitFor({state:'visible'});
  assert.equal(await page.locator('#next-question').isDisabled(),true);
  await page.getByRole('button',{name:'重试保存',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#next-question').disabled);assert.equal(savedId,retryId);
  await page.unroute('**/api/answers');page.once('dialog',dialog=>dialog.accept());await page.locator('#exit-quiz').click();
  await page.setViewportSize({width:390,height:844});await page.locator('[data-tab="learn"]').click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'No mobile horizontal overflow');
  await page.screenshot({path:resolve(out,'phone-home.png'),fullPage:true,animations:'disabled'});
  // A second browser begins with a separate space, then recovers the original
  // vocabulary using its learning code, with no GPT headers or sign-in flow.
  const sourceSpace=await page.evaluate(async()=>await(await fetch('/api/session')).json());
  const other=await browser.newPage({viewport:{width:1024,height:1366}});
  await other.goto(process.env.TEST_URL||'http://127.0.0.1:4178/');await other.locator('#learn-view').waitFor({state:'visible'});
  const newSpace=await other.evaluate(async()=>await(await fetch('/api/session')).json());assert.notEqual(newSpace.spaceId,sourceSpace.spaceId);
  // Custom meanings without reviewed examples reveal only the user's meaning.
  await other.evaluate(async spaceId=>{const r=await fetch('/api/words',{method:'POST',headers:{'Content-Type':'application/json','X-Learning-Space':spaceId},body:JSON.stringify({korean:'사과',chinese:'道歉'})});if(!r.ok)throw new Error(await r.text());},newSpace.spaceId);
  await other.reload();await other.locator('#learn-view').waitFor({state:'visible'});await other.emulateMedia({reducedMotion:'reduce'});await other.locator('#start-next').click();await other.locator('[data-confidence="unknown"]').click();assert.equal(await other.locator('#study-chinese').innerText(),'道歉');assert.equal(await other.locator('#study-details').isVisible(),false,'Do not show the apple example for a different personal meaning');
  const reducedAnimation=await other.locator('#study-view').evaluate(el=>getComputedStyle(el).animationName);assert.equal(reducedAnimation,'none');
  other.once('dialog',dialog=>dialog.accept());await other.locator('#exit-study').click();
  await other.locator('#space-button').click();await other.locator('#restore-code').fill(sourceSpace.learningCode);await other.locator('#restore-form button[type="submit"]').click();await other.locator('#space-dialog').waitFor({state:'hidden'});
  await other.locator('[data-tab="words"]').click();assert.equal(await other.locator('.word-row').count(),10);
  const before=await page.evaluate(async()=>await(await fetch('/api/words')).json());
  const learned=before.words.find(w=>w.masteryKo&&w.masteryZh);assert.ok(learned);assert.ok(learned.reviewAt>Date.now());
  const mirrored=await other.evaluate(async()=>await(await fetch('/api/words')).json());assert.equal(mirrored.words.find(w=>w.id===learned.id).reviewAt,learned.reviewAt);
  const row=other.locator('.word-row').filter({has:other.locator('.word-korean',{hasText:learned.korean})});assert.equal(await row.locator('.badge').innerText(),'已熟悉');
  await page.evaluate(async({spaceId,wordId})=>{const r=await fetch('/api/answers',{method:'POST',headers:{'Content-Type':'application/json','X-Learning-Space':spaceId},body:JSON.stringify({id:crypto.randomUUID(),wordId,direction:'ko',correct:false,retry:false})});if(!r.ok)throw new Error(await r.text());},{spaceId:sourceSpace.spaceId,wordId:learned.id});
  await other.waitForTimeout(1600);await other.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await other.waitForFunction(korean=>Array.from(document.querySelectorAll('.word-row')).some(row=>row.querySelector('.word-korean').textContent===korean&&row.querySelector('.badge').textContent==='待巩固'),learned.korean);
  assert.ok(Number(await other.locator('#review-count').innerText())>=1);
  await other.locator('[data-tab="learn"]').click();await other.locator('#start-review').click();await other.locator('#quiz-view').waitFor({state:'visible'});assert.match(await other.locator('#quiz-label').innerText(),/到期复习/);
  await other.close();
  assert.equal(errors.length,0,errors.join('\n'));
  const report={status:'passed',viewport:'1024x1366 iPad-sized Edge, 390x844 phone-sized Edge',cardCount,cardsDoNotMarkLearned:true,selfRatingChoices:3,difficultCardsPrioritized:true,correctedRecallSupported:true,animationDoubleTapProtected:true,reducedMotion:true,customMeaningDoesNotShowWrongExample:true,watercolorAssetLoaded:true,questionCount,firstRound:'19/20',unknownAnswerSupported:true,retryCleared:true,retryOptionsChanged,reloadProgress:true,saveRetrySameId:true,learningCodeRestoredInNewBrowser:true,reviewScheduleShared:true,otherDeviceProgressUpdatedOnFocus:true,dueReviewEntryWorks:true,noGPTLogin:true,mobileOverflow:false,pageErrors:errors,webmcp:'Unavailable: no native supported browser context'};
  await writeFile(resolve(out,'browser-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
