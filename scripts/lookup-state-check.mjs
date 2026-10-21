import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
await mkdir('artifacts',{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
async function pair(page,korean,chinese){await page.evaluate(async({korean,chinese})=>{const space=await(await fetch('/api/session')).json();const response=await fetch('/api/words',{method:'POST',headers:{'Content-Type':'application/json','X-Learning-Space':space.spaceId},body:JSON.stringify({korean,chinese})});if(!response.ok)throw new Error(await response.text());},{korean,chinese});}
try {
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),other=await browser.newPage();
  await page.goto('http://127.0.0.1:4178/');await page.locator('#learn-view').waitFor({state:'visible'});await pair(page,'친구','朋友');await page.reload();await page.locator('#learn-view').waitFor({state:'visible'});
  await other.goto('http://127.0.0.1:4178/');await other.locator('#learn-view').waitFor({state:'visible'});await pair(other,'사과','道歉');const target=await other.evaluate(async()=>await(await fetch('/api/session')).json());
  await page.locator('[data-tab="add"]').click();await page.locator('#lookup-input').fill('사과');await page.locator('#lookup-button').click();await page.locator('#confirm-form').waitFor({state:'visible'});
  await page.route('**/api/words',route=>route.request().method()==='GET'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'模拟词库读取失败'})}):route.continue());
  await page.locator('#space-button').click();await page.locator('#restore-code').fill(target.learningCode);await page.locator('#restore-form button').click();await page.waitForFunction(()=>document.querySelector('#space-status').textContent.includes('模拟'));
  assert.equal(await page.locator('#word-count').innerText(),'0');assert.equal(await page.locator('#confirm-form').isVisible(),false);assert.equal(await page.locator('#lookup-input').inputValue(),'');assert.equal(await page.locator('#lookup-button').isEnabled(),true);assert.equal(await page.locator('body').getAttribute('data-lookup'),'search');
  await page.unroute('**/api/words');await page.locator('#space-dialog [data-close-dialog]').click();await page.reload();await page.locator('#learn-view').waitFor({state:'visible'});await page.locator('[data-tab="words"]').click();assert.deepEqual(await page.locator('.word-korean').allTextContents(),['사과']);
  let release,complete;const held=new Promise(resolve=>release=resolve),done=new Promise(resolve=>complete=resolve);await page.route('**/api/lookup',async route=>{await held;await route.fulfill({contentType:'application/json',body:JSON.stringify({korean:'가치관',chinese:'价值观',source:'测试'})});complete();});
  await page.locator('[data-tab="add"]').click();await page.locator('#lookup-input').fill('가치관');await page.locator('#lookup-button').click();assert.equal(await page.locator('#lookup-button').isDisabled(),true);
  await page.locator('#space-button').click();await page.locator('#restore-code').fill(target.learningCode);await page.locator('#restore-form button').click();await page.locator('#space-dialog').waitFor({state:'hidden'});release();await done;await page.unroute('**/api/lookup');await page.locator('[data-tab="add"]').click();assert.equal(await page.locator('#lookup-button').isEnabled(),true);assert.equal(await page.locator('#lookup-input').inputValue(),'');
  await page.locator('#lookup-input').fill('사과');await page.locator('#lookup-button').click();await page.locator('#confirm-form').waitFor({state:'visible'});
  await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:330});visualViewport.dispatchEvent(new Event('resize'));});
  const bounds=await page.locator('#save-word-button').boundingBox();assert.ok(bounds.y+bounds.height<=330);assert.equal(await page.locator('body').getAttribute('data-keyboard'),'true');assert.equal(await page.locator('.topbar').isVisible(),false);
  await page.evaluate(()=>{delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'));});assert.equal(await page.locator('.topbar').isVisible(),true);
  const report={status:'passed',switchedSpaceReadFailureClearsOldData:true,pendingLookupCannotDisableNewSpace:true,confirmationKeyboardFits:true,lookupInputRestored:true};await writeFile('artifacts/lookup-state-check.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
