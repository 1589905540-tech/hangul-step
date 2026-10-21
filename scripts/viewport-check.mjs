import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {DICTIONARY} from '../src/dictionary.mjs';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
await mkdir('artifacts',{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const checks=[];
async function audit(page,name,selectors=[]){
  const report=await page.evaluate(selectors=>{
    const outside=[];
    for(const selector of selectors)for(const el of document.querySelectorAll(selector)){
      if(!el.getClientRects().length)continue;const r=el.getBoundingClientRect();
      if(r.top < -1 || r.bottom > innerHeight+1 || r.left < -1 || r.right > innerWidth+1)outside.push({selector,top:r.top,bottom:r.bottom,height:r.height});
    }
    return {height:innerHeight,documentHeight:document.documentElement.scrollHeight,scrollY, outside};
  },selectors);
  assert.ok(report.documentHeight<=report.height+2,name+' document exceeds viewport: '+JSON.stringify(report));
  assert.deepEqual(report.outside,[],name+' controls outside viewport');
  await page.evaluate(()=>window.scrollTo(0,200));assert.equal(await page.evaluate(()=>scrollY),0,name+' page must not scroll');
  checks.push({name,...report});
}
async function populate(page,items){await page.evaluate(async items=>{const space=await(await fetch('/api/session')).json();const response=await fetch('/api/words',{method:'POST',headers:{'Content-Type':'application/json','X-Learning-Space':space.spaceId},body:JSON.stringify({items})});if(!response.ok)throw new Error(await response.text());},items);}
try {
  for(const viewport of [{width:375,height:667},{width:390,height:844},{width:360,height:640},{width:375,height:568},{width:844,height:390}]){
    const page=await browser.newPage({viewport,isMobile:true,hasTouch:true});await page.emulateMedia({reducedMotion:'reduce'});
    const name=viewport.width+'x'+viewport.height;await page.goto('http://127.0.0.1:4178/');await page.locator('#learn-view').waitFor({state:'visible'});
    await audit(page,name+' home',['.brand','#start-next','#start-review','nav']);
    await page.locator('[data-tab="add"]').click();await audit(page,name+' lookup search',['#lookup-input','#lookup-button']);
    await page.locator('#lookup-input').fill('사과');await page.locator('#lookup-button').click();await page.locator('#confirm-form').waitFor({state:'visible'});
    assert.equal(await page.locator('#lookup-form').isVisible(),false);await audit(page,name+' meaning confirmation',['#lookup-choice','#korean-input','#chinese-input','#save-word-button','#lookup-again']);
    await page.locator('#lookup-again').click();await page.locator('#lookup-input').fill('친구');await page.locator('#lookup-button').click();await page.locator('#confirm-form').waitFor({state:'visible'});await page.locator('#save-word-button').click();await page.locator('#confirm-form').waitFor({state:'hidden'});
    await page.locator('[data-tab="learn"]').click();await page.locator('#start-next').click();await page.locator('#study-view').waitFor({state:'visible'});await audit(page,name+' recall',['#study-korean','#study-assessment','.quiz-toolbar']);
    await page.locator('[data-confidence="known"]').click();await audit(page,name+' expanded card',['#study-korean','#study-example-card','#study-phrase-card','#study-followup']);
    if(viewport.width===375&&viewport.height===667)await page.screenshot({path:'artifacts/phone-667-sprout-card.png',animations:'disabled'});
    await page.locator('#next-study').click();await page.locator('#quiz-view').waitFor({state:'visible'});await audit(page,name+' four choices',['#question','.answer-option','#unknown-answer']);
    while(await page.locator('#quiz-view').isVisible()){
      await page.locator('#unknown-answer').click();await page.waitForFunction(()=>!document.querySelector('#next-question').disabled);await audit(page,name+' answer',['#question','#quiz-chinese','#quiz-example-card','#quiz-phrase-card','#next-question']);await page.locator('#next-question').click();
    }
    await audit(page,name+' result',['#result-view .result-card','#finish-session','#retry-session']);await page.locator('#finish-session').click();
    for(let i=0;i<30;i+=10)await populate(page,DICTIONARY.slice(i,i+10).map(({korean,chinese})=>({korean,chinese})));
    await page.reload();await page.locator('#learn-view').waitFor({state:'visible'});await page.locator('[data-tab="words"]').click();assert.equal(await page.locator('#word-count').innerText(),'30');assert.equal(await page.locator('#group-picker option').count(),3);
    const seen=new Set();let pages=0;
    do{await audit(page,name+' library '+(++pages),['#group-picker','#start-picked-group','.word-row','#library-pagination']);for(const word of await page.locator('.word-korean').allTextContents())seen.add(word);if(await page.locator('#library-next').isDisabled())break;await page.locator('#library-next').click();}while(pages<=30);
    assert.equal(seen.size,30,'All words remain accessible through pagination');
    await page.locator('#group-picker').selectOption('2');await page.locator('#start-picked-group').click();await page.locator('#study-view').waitFor({state:'visible'});assert.equal(await page.locator('#study-counter').innerText(),'1 / 10');page.once('dialog',dialog=>dialog.accept());await page.locator('#exit-study').click();
    if(viewport.width===375&&viewport.height===667){
      await page.locator('[data-tab="learn"]').click();await page.screenshot({path:'artifacts/phone-667-sprout-home.png',animations:'disabled'});
      const korean='가'.repeat(100),chinese='这是为了检查完整释义而输入的测试内容'.repeat(8).slice(0,120);await populate(page,[{korean,chinese}]);await page.reload();await page.locator('#learn-view').waitFor({state:'visible'});await page.locator('[data-tab="words"]').click();await page.locator('#group-picker').selectOption('3');await page.locator('#start-picked-group').click();await page.locator('#study-view').waitFor({state:'visible'});await audit(page,'long word recall',['#study-assessment','#study-full-word']);
      await page.locator('#study-full-word').click();assert.equal(await page.locator('#full-text-content').innerText(),korean);assert.equal((await page.locator('#full-text-content').innerText()).includes(chinese),false,'Recall reader must not reveal the meaning');await page.locator('#full-text-dialog [data-close-dialog]').click();
      await page.locator('[data-confidence="known"]').click();await audit(page,'long meaning',['#study-followup','#study-full-word']);await page.locator('#study-full-word').click();let full='';do{full+=await page.locator('#full-text-content').innerText();if(await page.locator('#full-text-next').isDisabled())break;await page.locator('#full-text-next').click();}while(true);assert.equal(full,korean+'\n\n'+chinese);await page.locator('#full-text-dialog [data-close-dialog]').click();
      await page.locator('#next-study').click();await page.locator('#quiz-view').waitFor({state:'visible'});await audit(page,'long question',['#quiz-full-word','.answer-option','#unknown-answer']);
    }
    await page.close();
  }
  await writeFile('artifacts/viewport-check.json',JSON.stringify({status:'passed',checks,paginationCoversAllWords:true,longContentReadable:true,recallReaderDoesNotRevealMeaning:true},null,2));console.log(JSON.stringify({status:'passed',screensChecked:checks.length,paginationCoversAllWords:true,longContentReadable:true}));
}finally{await browser.close();}
