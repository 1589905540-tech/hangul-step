import {groupsOf, makeOptions, makeSession, recordAnswer, advance, pendingWords, normalize, overlaps, shuffle} from '/core.mjs';
import {DICTIONARY} from '/dictionary.mjs';
import {EXAMPLES} from '/examples.mjs';
import {createWordAudio} from '/word-audio.mjs';
import {createLocalStore} from '/local-store.mjs';
import {createOfflineLookup} from '/offline-lookup.mjs';
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
let words = [], session = null, tab = 'learn', options = [], answered = false, deleteId = null, toastTimer;
let lastGroup = [], lastLabel = '', savePayload = null, saving = false, loading = false;
let lookupSequence = 0, wordSaving = false, currentSpace=null;
let refreshing=false, lastRefresh=0, wordsSequence=0, studyCards=[], studyIndex=0;
let studyConfidence=null, changingCard=false, motionVersion=0;
let resultPage=0;
let readingPages=[],readingPage=0;
let preparingPractice=false, practiceDefaults=DICTIONARY, studySavePayload=null, studySaving=false;
let practiceVersion=0;
const meaningCache=new Map();
const studyDifficult=new Set();
const studyRatings=new Map();
const reduceMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
// Enable native :active feedback on older iPad Safari without blocking scrolling or clicks.
document.body.addEventListener('touchstart',()=>{}, {passive:true});
function syncViewport(){
  const viewport=window.visualViewport,height=viewport&&viewport.scale===1?viewport.height:innerHeight;
  document.documentElement.style.setProperty('--app-height',Math.round(height)+'px');
  document.body.dataset.keyboard=height<innerHeight-100?'true':'false';
}
syncViewport();window.addEventListener('resize',syncViewport);window.visualViewport?.addEventListener('resize',syncViewport);
function enterMotion(element) {element.classList.remove('page-entering');void element.offsetWidth;element.classList.add('page-entering');}
async function changeCard(view,render) {
  if(changingCard||tab!==view)return;
  changingCard=true;const version=++motionVersion;const element=$('#'+view+'-view');
  element.classList.add('page-leaving');
  if(!reduceMotion.matches)await new Promise(resolve=>setTimeout(resolve,140));
  if(version!==motionVersion||tab!==view)return;
  render();element.classList.remove('page-leaving');
  if(tab===view)enterMotion(element);
  changingCard=false;
}
// Personal vocabulary, practice and option history all stay on this device.
const choiceHistory = new Map();
try { const saved=JSON.parse(localStorage.getItem('ten-words-choice-history')||'[]');if(Array.isArray(saved))for(const [key,value] of saved.slice(-300))if(typeof key==='string'&&Array.isArray(value)&&value.length===4&&value.every(o=>typeof o.label==='string'&&typeof o.correct==='boolean'))choiceHistory.set(key,value); } catch {}
function rememberChoices(key,value) {
  choiceHistory.delete(key);choiceHistory.set(key,value);
  while(choiceHistory.size>300)choiceHistory.delete(choiceHistory.keys().next().value);
  try {localStorage.setItem('ten-words-choice-history',JSON.stringify([...choiceHistory]));}catch{}
}
function makeId(){if(globalThis.crypto?.randomUUID)return crypto.randomUUID();const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);}
const lookupCache = new Map();
const localStore=createLocalStore({makeId});
const localDictionary=createOfflineLookup({includeRecordings:false});
const changes=typeof BroadcastChannel==='function'?new BroadcastChannel('spring-local-changes'):null;
let lookupCandidates=[],manualQuery=null;
let legacyImportEnabled=false;
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  if(path==='/api/lookup')return localDictionary.lookup(body.text);
  if(path==='/api/session'){
    const state=method==='GET'?await localStore.read():await localStore.setSpace(body.code,{allowCreate:false});
    return {spaceId:state.spaceId,learningCode:state.code};
  }
  if(path==='/api/words' && method==='GET'){
    const state=await localStore.read();
    return {spaceId:state.spaceId,words:state.words};
  }
  if(path==='/api/words' && method==='POST'){
    let added=0;
    for(const pair of body.items||[body]){
      const recording=await localDictionary.recording(pair.korean,pair.chinese).catch(()=>null);
      try{await localStore.putWord({...pair,recording});added++;}
      catch(error){if(!body.items||!error.message.includes('已经有'))throw error;}
    }
    changes?.postMessage({spaceId:currentSpace?.spaceId});return {added};
  }
  const match=/^\/api\/words\/([a-zA-Z0-9-]+)$/.exec(path);
  if(match && method==='PATCH'){
    const recording=await localDictionary.recording(body.korean,body.chinese).catch(()=>null);
    await localStore.putWord({...body,recording},match[1]);
  }else if(match && method==='DELETE')await localStore.deleteWord(match[1]);
  else if(path==='/api/answers')await localStore.answer(body);
  else throw new Error('这个操作暂不支持。');
  changes?.postMessage({spaceId:currentSpace?.spaceId});return {saved:true};
}
// Read an existing server vocabulary once when upgrading to the device edition.
async function legacyApi(path, spaceId, body) {
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),5000);
  try {
    const headers=spaceId?{'X-Learning-Space':spaceId}:{};if(body)headers['Content-Type']='application/json';
    const response = await fetch(path,{method:body?'POST':'GET',body:body?JSON.stringify(body):undefined,credentials:'same-origin',headers,signal:controller.signal});
    let data;
    try { data=await response.json(); } catch { throw new Error('连接暂时中断，请刷新重试。'); }
    if (!response.ok) throw Object.assign(new Error(data.error || '暂时无法完成，请重试。'), {status:response.status});
    return data;
  } catch(error) { if(error.name === 'AbortError') throw new Error('连接超时，请重试。'); throw error; }
  finally { clearTimeout(timeout); }
}
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent=message; $('#toast').hidden=false; toastTimer=setTimeout(()=>{$('#toast').hidden=true;},4500); }
let audioRequest=null,audioFailure=null,automaticAudioNotice=false;
let automaticAudio=true;
try{automaticAudio=localStorage.getItem('spring-auto-audio')!=='off';}catch{}
function audioMessage(failure){
  if(failure.automatic){
    if(!automaticAudioNotice){automaticAudioNotice=true;toast('韩语声音没有启动。可在“备份 → 发音”试听，并按提示下载韩语声音。');}
    refreshAudioSettings();return;
  }
  const {message,target:button,source,alternative,localVoiceAvailable,deviceSupported}=failure;
  if(!audioRequest||audioRequest.button!==button||$('dialog[open]')){toast(message);return;}
  audioFailure=failure;
  $('#audio-error-message').textContent=source==='recording'?'词典录音暂时连接不上。':message;
  $('#audio-error-word').textContent=audioRequest.word.korean;
  $('#switch-audio').hidden=!alternative;
  $('#switch-audio').textContent=alternative==='device'?'改用设备朗读':'改用词典录音';
  $('#audio-voice-help').hidden=!deviceSupported||(source==='recording'&&localVoiceAvailable);
  $('#audio-dialog').showModal();
}
function audioState(state,button){
  button.dataset.audio=state;
  button.dataset.audioLabel??=button.getAttribute('aria-label');
  button.setAttribute('aria-busy',String(state==='loading'));
  button.setAttribute('aria-pressed',String(state!=='idle'));
  button.setAttribute('aria-label',button.dataset.audioLabel+(state==='loading'?'，准备声音，点击停止':state==='playing'?'，正在朗读，点击停止':''));
  button.title=state==='loading'?'准备声音，点击停止':state==='playing'?'正在朗读，点击停止':button.dataset.audioLabel;
}
const wordAudio=createWordAudio({offlineOnly:true,synth:window.speechSynthesis,Utterance:window.SpeechSynthesisUtterance,onFailure:audioMessage,onState:audioState});
function stopAudio(){wordAudio.stop();}
function stopPronunciation(){stopAudio();audioRequest=null;audioFailure=null;if($('#audio-dialog').open)$('#audio-dialog').close();}
function playAudio(request,source='auto',settings={}){wordAudio.play({...request,target:request.button},source,settings);}
function autoReadWord(prefix,word){
  if(!automaticAudio||document.hidden||!word)return;
  const button=$('[data-speak="'+prefix+'-word"]');
  audioRequest={word,text:word.korean,button,recording:word.recording};
  playAudio(audioRequest,'auto',{restart:true,automatic:true});
}
function refreshAudioSettings(){
  $('#automatic-audio').checked=automaticAudio;
  $('#audio-device-status').textContent=wordAudio.localVoiceAvailable()?'已找到本机离线韩语声音':'尚未找到本机韩语声音，请先在系统设置中下载，再点试听。';
}
// WebKit requires the first speak() in a real user gesture. Prime before
// asynchronous dictionary loading and the next-card animation can consume it.
document.addEventListener('click',event=>{
  if(event.target.closest('#start-next,#start-review,#start-picked-group,#retry-session,#next-study,#next-question,#skip-study,[data-confidence],#study-wrong,#quiz-maybe,#quiz-wrong'))wordAudio.unlock();
},true);
$('#automatic-audio').addEventListener('change',event=>{
  automaticAudio=event.target.checked;try{localStorage.setItem('spring-auto-audio',automaticAudio?'on':'off');}catch{}
  if(!automaticAudio)stopPronunciation();
});
$('#preview-korean-audio').addEventListener('click',()=>{
  wordAudio.unlock();automaticAudioNotice=false;
  audioRequest={word:{korean:'안녕하세요'},text:'안녕하세요',button:$('#preview-korean-audio'),recording:null};
  playAudio(audioRequest,'device',{restart:true});refreshAudioSettings();
});
function retryAudio(switchSource){
  const request=audioRequest,source=switchSource?audioFailure?.alternative:audioFailure?.source;
  $('#audio-dialog').close();
  if(request&&source&&!request.button.disabled)playAudio(request,source);
}
$('#retry-audio').addEventListener('click',()=>retryAudio(false));
$('#switch-audio').addEventListener('click',()=>retryAudio(true));
function renderReading(){
  $('#full-text-content').textContent=readingPages[readingPage];$('#full-text-page').textContent=(readingPage+1)+' / '+readingPages.length;
  $('#full-text-previous').disabled=readingPage===0;$('#full-text-next').disabled=readingPage===readingPages.length-1;
}
function readFull(text,title='完整内容'){
  const characters=Array.from(text),size=innerHeight<480?80:140;readingPages=[];readingPage=0;
  for(let i=0;i<characters.length;i+=size)readingPages.push(characters.slice(i,i+size).join(''));
  $('#full-text-title').textContent=title;renderReading();$('#full-text-dialog').showModal();
}
$('#full-text-previous').addEventListener('click',()=>{readingPage--;renderReading();});
$('#full-text-next').addEventListener('click',()=>{readingPage++;renderReading();});
function fullMeaning(word){const senses=[...new Set([word.chinese,...(word.acceptedMeanings||[])].flatMap(value=>String(value??'').split(/[;；\r\n]+/)).map(normalize).filter(Boolean))];return senses.slice(0,3).join('; ');}
async function enrichedWord(word){let meanings=meaningCache.get(word.korean);if(!meanings){meanings=await localDictionary.meanings(word.korean);if(meanings!==null)meaningCache.set(word.korean,meanings);}return {...word,acceptedMeanings:meanings||[]};}
function showFullWordButton(prefix,word,revealed){$('#'+prefix+'-full-word').hidden=word.korean.length<=(innerHeight<500?8:12)&&(!revealed||fullMeaning(word).length<=(innerHeight<500?24:32));}
$('#study-full-word').addEventListener('click',()=>{const word=studyCards[studyIndex];readFull(word.korean+(studyConfidence===null?'':'\n\n'+fullMeaning(word)),'词卡全文');});
$('#quiz-full-word').addEventListener('click',()=>{const q=session.queue[session.index];readFull(answered?q.word.korean+'\n\n'+fullMeaning(q.word):(q.direction==='ko'?q.word.chinese:q.word.korean),'题目全文');});
function showView(name) {
  practiceVersion++;
  motionVersion++;changingCard=false;
  for (const id of ['learn','add','words','study','quiz','result']) {const element=$('#'+id+'-view');element.hidden=id!==name;element.classList.remove('page-leaving');}
  document.querySelectorAll('[data-tab]').forEach(button=>button.classList.toggle('active',button.dataset.tab === (['words','add'].includes(name)?name:'learn')));
  tab=name;
  document.body.dataset.view=name;delete document.body.dataset.answer;
  if(name==='study'||name==='quiz'){clearTimeout(toastTimer);$('#toast').hidden=true;}
  stopPronunciation();
  enterMotion($('#'+name+'-view'));
}
function status(word) { return word.masteryKo && word.masteryZh ? (word.reviewAt!==null&&word.reviewAt<=Date.now()?'该复习了':'已熟悉') : word.mistakes ? '待巩固' : word.masteryKo || word.masteryZh ? '练习中' : '新词'; }
function dueWords() {return words.filter(word=>word.reviewAt!==null&&word.reviewAt!==undefined&&word.reviewAt<=Date.now()).sort((a,b)=>a.reviewAt-b.reviewAt);}
function renderHome() {
  const groups=groupsOf(words);
  const due=dueWords();$('#review-count').textContent=due.length;
  $('#review-description').textContent=due.length?'每次复习最多 10 个词':words.some(w=>w.lastPracticedAt)?'今天没有到期的词':'练过的词会在这里';
  $('#group-count').textContent=groups.length;
  const newWords=words.filter(word=>!word.masteryKo||!word.masteryZh).length;
  $('#start-description').textContent=words.length?(newWords?'新词 '+newWords:'再熟悉一组'):'添加第一个词';
  $('#start-next').setAttribute('aria-label',words.length?'开始学习':'添加第一个生词');
  const selectedGroup=Number($('#group-picker')?.value||0);
  $('#group-grid').innerHTML=groups.length ? '<label class="group-picker"><span class="sr-only">选择学习小组，每组最多十词</span><select id="group-picker">'+groups.map((group,index)=>{
    const familiar=group.filter(word=>word.masteryKo && word.masteryZh).length;
    return '<option value="'+index+'"'+(index===Math.min(selectedGroup,groups.length-1)?' selected':'')+'>第 '+String(index+1).padStart(2,'0')+' 组 · '+familiar+' / '+group.length+' 已熟悉</option>';
  }).join('')+'</select></label><button id="start-picked-group" class="text-button">学习这组</button>' : '<div class="empty-state"><strong>还没有生词</strong><button id="add-first-word" class="primary-button">添加生词</button><button id="add-samples" class="text-button">加入示例词</button></div>';
}
function renderWords({resetScroll=false}={}) {
  $('#word-count').textContent=words.length;
  const query=normalize($('#word-search').value).toLowerCase();
  const visible=words.filter(word=>word.korean.includes(query)||word.chinese.toLowerCase().includes(query));
  const list=$('#word-list'),scrollTop=resetScroll?0:list.scrollTop;
  list.innerHTML=visible.length ? visible.map(word=>'<div class="word-row"><span class="word-number">'+String(words.indexOf(word)+1).padStart(2,'0')+'</span><button class="word-korean" data-read-word="'+escape(word.id)+'" lang="ko" aria-label="查看 '+escape(word.korean)+' 全文">'+escape(word.korean)+'</button><button class="word-chinese" data-read-word="'+escape(word.id)+'" aria-label="查看 '+escape(word.korean)+' 的完整释义">'+escape(word.chinese)+'</button><span class="badge">'+status(word)+'</span><div class="word-actions"><button data-edit="'+escape(word.id)+'" aria-label="修改 '+escape(word.korean)+'">修改</button><button data-delete="'+escape(word.id)+'" aria-label="移除 '+escape(word.korean)+'">移除</button></div></div>').join('') : query?'<div class="empty-state">未找到生词</div>':'';
  list.scrollTop=scrollTop;
}
async function loadWords({background=false}={}) {
  const expectedSpace=currentSpace?.spaceId;
  const sequence=++wordsSequence;
  const data=await api('/api/words');
  if(data.spaceId!==expectedSpace || currentSpace?.spaceId!==expectedSpace)throw new Error('学习空间已切换，请刷新后再操作。');
  if(sequence!==wordsSequence || (background&&(tab==='quiz'||tab==='study'||wordSaving||saving||$('dialog[open]'))))return;
  words=data.words; renderHome(); renderWords();
  lastRefresh=Date.now();
  $('#sync-status').textContent='已保存在此设备';
}
async function refreshLocal() {
  if(refreshing||loading||!currentSpace||document.hidden||tab==='quiz'||tab==='study'||wordSaving||saving||$('dialog[open]')||Date.now()-lastRefresh<1500)return;
  refreshing=true;lastRefresh=Date.now();
  try {await loadWords({background:true});}
  catch(error){$('#sync-status').textContent=error.message;}
  finally{refreshing=false;}
}
async function init() {
  loading=true;
  try {
    const state=await localStore.initialize();
    currentSpace={spaceId:state.spaceId,learningCode:state.code};
    await loadWords(); $('#load-status').hidden=true; showView('learn');
    setupOffline();
    // This edition never checks a server account while opening the wordbook.
    // Existing local records and imported JSON backups remain available.
    legacyImportEnabled=false;$('#legacy-import').hidden=true;
  }
  catch(error) { $('#load-status').innerHTML='<p>'+escape(error.message)+'</p><button id="retry-load" class="secondary-button">重试</button>'; }
  finally { loading=false; }
}
async function importOriginal(code=''){
  let old=await legacyApi('/api/session');
  if(normalize(code))old=await legacyApi('/api/session',old.spaceId,{code:normalize(code)});
  const data=await legacyApi('/api/words',old.spaceId);
  if(data.spaceId!==old.spaceId)throw new Error('原词库已切换，请重新导入。');
  const imported=await localStore.importBackup({schemaVersion:1,words:data.words});
  // An active practice keeps its question list; the next visit shows added words.
  await loadWords({background:true});changes?.postMessage({spaceId:currentSpace?.spaceId});return imported;
}
function lookupStage(stage){document.body.dataset.lookup=stage;$('#add-page-title').textContent=stage==='result'?'查词结果':'添加生词';}
function focusLookup(){(document.body.dataset.lookup==='result'?$('#chinese-input'):$('#lookup-input')).focus();}
function resetLookup(){
  lookupSequence++;manualQuery=null;lookupCandidates=[];lookupStage('search');
  $('#lookup-input').value='';$('#korean-input').value='';$('#chinese-input').value='';$('#lookup-status').textContent='';$('#confirm-form').hidden=true;
  $('#lookup-choice-row').hidden=true;$('#lookup-choice').replaceChildren();$('#lookup-button').disabled=false;$('#lookup-button').textContent='查词';
}
function openManual(text) {
  lookupStage('result');
  lookupCandidates=[];$('#lookup-choice-row').hidden=true;
  if(manualQuery!==text){
    $('#korean-input').value=/[\uac00-\ud7af\u3130-\u318f\u1100-\u11ff]/.test(text)?text:'';
    $('#chinese-input').value=/[\u3400-\u9fff]/.test(text)?text:'';
    manualQuery=text;
  }
  $('#translation-source').textContent='手动填写'; $('#confirm-form').hidden=false;
  $('#korean-input').value ? $('#chinese-input').focus() : $('#korean-input').focus();
}
async function lookup(text) {
  if(wordSaving) {toast('保存中…');return;}
  const sequence=++lookupSequence;
  const value=normalize(text);
  if (!value) { toast('输入韩文或中文'); return; }
  $('#lookup-input').value=value;
  lookupStage('search');
  $('#lookup-input').blur();
  $('#lookup-button').disabled=true; $('#lookup-button').textContent='查找中…';
  $('#lookup-status').className='lookup-status'; $('#lookup-status').textContent=''; $('#confirm-form').hidden=true;
  $('#lookup-choice-row').hidden=true;
  try {
    const result=lookupCache.get(value) || await api('/api/lookup',{text:value});
    if (sequence!==lookupSequence) return;
    lookupCache.set(value,result);
    manualQuery=null;
    $('#korean-input').value=result.korean; $('#chinese-input').value=result.chinese; $('#translation-source').textContent=result.source;
    lookupCandidates=result.candidates||[];$('#lookup-choice-row').hidden=lookupCandidates.length<2;
    $('#lookup-choice').replaceChildren(...lookupCandidates.map((candidate,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=candidate.korean+' · '+candidate.chinese;return option;}));
    $('#lookup-status').textContent=result.totalCandidates>lookupCandidates.length?'显示 '+lookupCandidates.length+' / '+result.totalCandidates+' 项':''; $('#confirm-form').hidden=false;lookupStage('result');
  } catch(error) {
    if (sequence!==lookupSequence) return;
    $('#lookup-status').className='lookup-status error'; $('#lookup-status').textContent=error.message;
    openManual(value);
    const retry=document.createElement('button');retry.className='text-button';retry.type='button';retry.textContent='重新查词';retry.addEventListener('click',()=>lookup(value));$('#lookup-status').append(document.createElement('br'),retry);
  } finally { if(sequence===lookupSequence){$('#lookup-button').disabled=false; $('#lookup-button').textContent='查词';} }
}
$('#lookup-form').addEventListener('submit',event=>{event.preventDefault();lookup($('#lookup-input').value);});
$('#lookup-again').addEventListener('click',()=>{lookupStage('search');$('#confirm-form').hidden=true;$('#lookup-status').textContent='';$('#lookup-input').focus();});
$('#lookup-choice').addEventListener('change',()=>{const candidate=lookupCandidates[Number($('#lookup-choice').value)];if(!candidate)return;$('#korean-input').value=candidate.korean;$('#chinese-input').value=candidate.chinese;$('#translation-source').textContent=candidate.source;});
$('#confirm-form').addEventListener('submit',async event=>{
  event.preventDefault(); const button=$('#save-word-button'); if(button.disabled) return;
  const korean=normalize($('#korean-input').value), chinese=normalize($('#chinese-input').value);
  wordSaving=true;
  const controls=document.querySelectorAll('#lookup-form input,#lookup-form button,#confirm-form input,#confirm-form button,#confirm-form select');
  controls.forEach(control=>control.disabled=true);
  try {
    await api('/api/words',{korean,chinese});
    manualQuery=null;
    try { await loadWords(); toast('已添加'); } catch { toast('已保存，词库刷新失败，请刷新页面。'); }
    lookupStage('search');
    $('#confirm-form').hidden=true; $('#lookup-status').textContent=''; $('#lookup-input').value='';
  } catch(error) { toast(error.message); } finally {wordSaving=false;controls.forEach(control=>control.disabled=false);focusLookup();}
});
async function startPractice(group,label,{direct=false}={}) {
  if(preparingPractice)return;
  if(!group.length) {toast('先添加一个生词。');return;}
  preparingPractice=true;
  const startVersion=practiceVersion,startSpace=currentSpace.spaceId,sourceWords=[...words];
  try {const enriched=await Promise.all([...sourceWords,...DICTIONARY].map(enrichedWord));if(practiceVersion!==startVersion||currentSpace.spaceId!==startSpace||group.some(word=>!words.some(current=>current.id===word.id&&current.generation===word.generation)))return;const own=enriched.slice(0,sourceWords.length);practiceDefaults=enriched.slice(sourceWords.length);group=group.map(word=>own.find(item=>item.id===word.id)||word);}
  catch(error){toast('词典暂未准备好，先使用已保存的释义。');}
  finally{preparingPractice=false;}
  lastGroup=[...group]; lastLabel=label; session=makeSession(group);studyDifficult.clear();studyRatings.clear();studySavePayload=null;
  studyCards=direct?[]:shuffle(group.filter(word=>!word.masteryKo||!word.masteryZh));studyIndex=0;
  if(studyCards.length){showView('study');renderStudyCard();}else beginQuiz();
  window.scrollTo({top:0,behavior:'smooth'});
}
function renderStudyCard() {
  const word=studyCards[studyIndex];studyConfidence=null;studySavePayload=null;
  stopPronunciation();
  window.scrollTo({top:0,behavior:'instant'});
  $('#study-label').textContent=lastLabel;$('#study-counter').textContent=(studyIndex+1)+' / '+studyCards.length;
  $('#study-korean').textContent=word.korean;$('#study-chinese').textContent=fullMeaning(word);$('#study-chinese').hidden=true;
  $('#study-feedback').textContent='';$('#study-save-status').textContent='';$('#study-wrong').textContent='记错了';$('#study-wrong').setAttribute('aria-pressed','false');
  showFullWordButton('study',word,false);
  $('#study-veil').hidden=false;$('#study-details').hidden=true;$('#study-assessment').hidden=false;$('#study-followup').hidden=true;$('#next-study').disabled=true;$('#study-wrong').disabled=false;
  $('#next-study').textContent=studyIndex+1<studyCards.length?'下一词':'开始练习';
  $('#study-dots').innerHTML=studyCards.map((_,i)=>'<span class="study-dot'+(i<=studyIndex?' active':'')+'"></span>').join('');
  $('#study-korean').focus({preventScroll:true});
  autoReadWord('study',word);
}
function populateDetails(prefix,word) {
  const reviewed=DICTIONARY.find(item=>normalize(item.korean)===normalize(word.korean)&&overlaps({...item,korean:'reviewed-meaning'}, {...word,korean:'personal-meaning',acceptedMeanings:[]}));
  const example=reviewed&&EXAMPLES[reviewed.korean];
  $('#'+prefix+'-example-card').hidden=!example;$('#'+prefix+'-phrase-card').hidden=!example;
  $('#'+prefix+'-example-card').querySelector('[data-speak]').hidden=!wordAudio.canSpeak();
  if(example){$('#'+prefix+'-sentence').textContent=example.koreanSentence;$('#'+prefix+'-sentence-zh').textContent=example.chineseSentence;$('#'+prefix+'-phrase').textContent=example.phrase;$('#'+prefix+'-phrase-zh').textContent=example.chinesePhrase;}
  return Boolean(example);
}
async function saveStudyAssessment() {
  if(studySaving||!studySavePayload)return;
  studySaving=true;$('#next-study').disabled=true;$('#study-wrong').disabled=true;$('#skip-study').disabled=true;
  $('#study-save-status').textContent='保存中…';
  try{const state=await localStore.answer(studySavePayload);words=state.words;$('#study-save-status').textContent='';$('#next-study').disabled=false;}
  catch(error){$('#study-save-status').textContent=error.message+' ';const retry=document.createElement('button');retry.className='text-button';if([404,409].includes(error.status)){retry.textContent='结束练习并刷新词库';retry.onclick=async()=>{retry.disabled=true;try{await loadWords();studySavePayload=null;studyCards=[];session=null;showView('learn');toast('词库已刷新，可以重新开始。');}catch(nextError){toast(nextError.message);retry.disabled=false;}};}else{retry.textContent='重试保存';retry.onclick=saveStudyAssessment;}$('#study-save-status').append(retry);}
  finally{studySaving=false;$('#study-wrong').disabled=false;$('#skip-study').disabled=$('#next-study').disabled;}
}
async function assessStudy(confidence,{corrected=false}={}) {
  if(tab!=='study'||changingCard||studySaving||(!corrected&&studyConfidence!==null))return;
  autoReadWord('study',studyCards[studyIndex]);
  if(corrected&&studyConfidence==='unknown'){toast('已记为忘记，本轮稍后再练');return;}
  studyConfidence=confidence;const word=studyCards[studyIndex];
  if(confidence!=='known')studyDifficult.add(word.id);
  $('#study-chinese').hidden=false;$('#study-veil').hidden=true;$('#study-details').hidden=!populateDetails('study',word);
  showFullWordButton('study',word,true);
  $('#study-assessment').hidden=true;$('#study-followup').hidden=false;
  const rating={known:'good',maybe:'hard',unknown:'again'}[confidence];
  studyRatings.set(word.id,rating);
  $('#study-feedback').textContent=rating==='again'?'已记为忘记 · 本轮稍后再练':rating==='hard'?'已记为模糊 · 更早复习':'已记为认识';
  $('#study-wrong').textContent=rating==='again'?'已记错':'记错了';$('#study-wrong').setAttribute('aria-pressed',String(rating==='again'));
  studySavePayload={id:makeId(),wordId:word.id,generation:word.generation,direction:'zh',correct:rating!=='again',retry:false,rating,phase:'recall',correction:corrected};
  enterMotion($('#study-details'));
  $('#study-korean').focus({preventScroll:true});
  await saveStudyAssessment();
}
function beginQuiz(){if(studySaving||(tab==='study'&&studySavePayload&&$('#next-study').disabled))return;studyCards=[];session=makeSession(lastGroup);session.queue=['ko','zh'].flatMap(direction=>session.queue.filter(q=>q.direction===direction).sort((a,b)=>Number(studyDifficult.has(b.word.id))-Number(studyDifficult.has(a.word.id))));showView('quiz');renderQuestion();window.scrollTo({top:0,behavior:'instant'});}
$('#study-assessment').addEventListener('click',event=>{const button=event.target.closest('[data-confidence]');if(button)assessStudy(button.dataset.confidence);});
$('#study-wrong').addEventListener('click',()=>assessStudy('unknown',{corrected:true}));
$('#next-study').addEventListener('click',()=>{if($('#next-study').disabled)return;changeCard('study',()=>{studyIndex++;if(studyIndex<studyCards.length)renderStudyCard();else beginQuiz();});});
$('#skip-study').addEventListener('click',beginQuiz);
$('#exit-study').addEventListener('click',()=>leaveQuiz());
function renderQuestion() {
  const q=session.queue[session.index]; answered=false; savePayload=null;
  stopPronunciation();
  window.scrollTo({top:0,behavior:'instant'});
  delete document.body.dataset.answer;$('#answer-options').hidden=false;$('#quiz-chinese').hidden=true;$('#quiz-details').hidden=true;
  $('[data-speak="quiz-word"]').disabled=false;
  $('#quiz-label').textContent=lastLabel; $('#quiz-counter').textContent=(session.index+1)+' / '+session.queue.length;
  const percent=Math.round(session.index/session.queue.length*100); $('#quiz-progress').style.width=percent+'%'; $('.progress-track').setAttribute('aria-valuenow',percent);
  $('#question-direction').textContent=(q.retry?'错题再练 · ':'')+(q.direction==='ko'?'看中文 · 选韩文':'看韩文 · 选中文');
  $('#question').textContent=q.direction==='ko'?q.word.chinese:q.word.korean;
  $('#question').lang=q.direction==='ko'?'zh-CN':'ko';
  $('#quiz-full-word').hidden=(q.direction==='ko'?q.word.chinese:q.word.korean).length<=(innerHeight<500?8:12);
  $('#answer-feedback').textContent=''; $('#answer-feedback').className='answer-feedback'; $('#answer-save-status').textContent='';
  $('#next-question').hidden=true; $('#next-question').disabled=true;
  $('#quiz-maybe').hidden=true;$('#quiz-wrong').hidden=true;
  $('#unknown-answer').hidden=false;$('#unknown-answer').disabled=false;
  try {const historyKey=currentSpace.spaceId+':'+q.word.id+':'+q.direction;const own=words.map(word=>({...word,acceptedMeanings:meaningCache.get(word.korean)||[]}));options=makeOptions(q.word,q.direction,own,practiceDefaults,Math.random,choiceHistory.get(historyKey)||[]);rememberChoices(historyKey,options);}
  catch(error) {toast(error.message);showView('learn');return;}
  $('#answer-options').innerHTML=options.map((option,index)=>'<div class="answer-cell'+(option.label.length>8?' long-label':'')+'"><button class="answer-option" data-option="'+index+'"><span class="option-letter">'+String.fromCharCode(65+index)+'</span><span lang="'+(q.direction==='ko'?'ko':'zh-CN')+'">'+escape(option.label)+'</span></button>'+(option.label.length>8?'<button class="option-full text-button" data-read-option="'+index+'" aria-label="查看选项 '+String.fromCharCode(65+index)+' 全文">全文</button>':'')+'</div>').join('');
  enterMotion($('#answer-options'));
  $('#question').focus({preventScroll:true});
  // Choice questions reveal their Korean pronunciation only after an answer.
}
async function saveAnswer() {
  if(saving || !savePayload) return;
  saving=true; $('#next-question').disabled=true; $('#answer-save-status').textContent='保存中…';
  $('#quiz-maybe').disabled=true;$('#quiz-wrong').disabled=true;
  try { const state=await localStore.answer(savePayload);words=state.words;$('#answer-save-status').textContent='';$('#next-question').disabled=false;$('#quiz-maybe').disabled=false;$('#quiz-wrong').disabled=false; }
  catch(error) {
    $('#answer-save-status').textContent=error.message+' ';
    const retry=document.createElement('button');retry.type='button';retry.className='text-button';
    if([404,409].includes(error.status)) {
      retry.textContent='结束练习并刷新词库';
      retry.addEventListener('click',async()=>{retry.disabled=true;try{await loadWords();session=null;savePayload=null;showView('learn');toast('词库已刷新，可以重新开始。');}catch(nextError){toast(nextError.message);retry.disabled=false;}});
    }else{retry.textContent='重试保存';retry.addEventListener('click',saveAnswer);}
    $('#answer-save-status').append(retry);
  } finally { saving=false; }
}
async function choose(index) {
  if(tab!=='quiz' || changingCard || answered || !session || (index!==-1&&!options[index])) return;
  answered=true;
  const q=session.queue[session.index], correct=index===-1?false:options[index].correct;
  autoReadWord('quiz',q.word);
  const rating=correct?(!q.retry&&q.direction==='zh'&&studyRatings.get(q.word.id)==='hard'?'hard':'good'):'again';
  recordAnswer(session,correct,{rating});
  $('#unknown-answer').hidden=true;
  document.querySelectorAll('[data-option]').forEach((button,i)=>{button.disabled=true;if(options[i].correct)button.classList.add('correct');else if(i===index)button.classList.add('wrong');});
  $('#answer-feedback').className='answer-feedback '+(correct?'correct':'wrong');
  $('#answer-feedback').textContent=correct?'答对':index===-1?'再记一次':'答错';
  document.body.dataset.answer=correct?'correct':'wrong';
  $('#answer-feedback').className='answer-feedback '+(rating==='again'?'wrong':rating==='good'?'correct':'');
  $('#question').textContent=q.word.korean;$('#question').lang='ko';
  $('#quiz-chinese').textContent=fullMeaning(q.word);$('#quiz-chinese').hidden=false;$('#answer-options').hidden=true;
  showFullWordButton('quiz',q.word,true);
  $('#quiz-details').hidden=!populateDetails('quiz',q.word);$('[data-speak="quiz-word"]').disabled=false;enterMotion($('#quiz-details'));
  $('#question').focus({preventScroll:true});
  savePayload={id:makeId(),wordId:q.word.id,generation:q.word.generation,direction:q.direction,correct,retry:q.retry,rating,phase:'quiz'};
  const local=words.find(w=>w.id===q.word.id);if(local){local[q.direction==='ko'?'masteryKo':'masteryZh']=Number(correct);if(!correct)local.mistakes++;}
  $('#next-question').textContent=session.index+1 < session.queue.length?'下一词':'本组结果';$('#next-question').hidden=false;
  $('#quiz-maybe').hidden=!correct;$('#quiz-wrong').hidden=!correct;
  $('#quiz-maybe').textContent='模糊';$('#quiz-wrong').textContent='记错了';
  if(rating==='hard'){$('#answer-feedback').textContent='已记为模糊 · 本轮稍后再练';$('#quiz-maybe').textContent='已记模糊';}
  if(!correct)$('#answer-feedback').textContent='已记为忘记 · 本轮稍后再练';
  await saveAnswer();
}
async function correctQuizRating(rating) {
  if(tab!=='quiz'||!answered||changingCard||saving||$('#next-question').disabled||!savePayload)return;
  autoReadWord('quiz',session.queue[session.index].word);
  if(savePayload.rating===rating){toast(rating==='hard'?'已记为模糊，本轮稍后再练':'已记为忘记，本轮稍后再练');return;}
  const q=session.queue[session.index],correct=rating!=='again';
  recordAnswer(session,correct,{rating,correction:true});
  savePayload={id:makeId(),wordId:q.word.id,generation:q.word.generation,direction:q.direction,correct,retry:q.retry,rating,phase:'quiz',correction:true};
  document.body.dataset.answer=correct?'correct':'wrong';
  $('#answer-feedback').className='answer-feedback '+(rating==='again'?'wrong':'');
  $('#answer-feedback').textContent=rating==='hard'?'已记为模糊 · 本轮稍后再练':'已记为忘记 · 本轮稍后再练';
  $('#quiz-maybe').textContent=rating==='hard'?'已记模糊':'模糊';$('#quiz-wrong').textContent=rating==='again'?'已记错':'记错了';
  $('#quiz-maybe').hidden=!correct;$('#next-question').textContent=session.index+1<session.queue.length?'下一词':'本组结果';
  await saveAnswer();
}
$('#quiz-maybe').addEventListener('click',()=>correctQuizRating('hard'));
$('#quiz-wrong').addEventListener('click',()=>correctQuizRating('again'));
$('#answer-options').addEventListener('click',event=>{const button=event.target.closest('[data-option]');if(button)choose(Number(button.dataset.option));});
$('#answer-options').addEventListener('click',event=>{const button=event.target.closest('[data-read-option]');if(button)readFull(options[Number(button.dataset.readOption)].label,'选项全文');});
$('#unknown-answer').addEventListener('click',()=>choose(-1));
$('#next-question').addEventListener('click',()=>{if(!answered||saving||$('#next-question').disabled)return;changeCard('quiz',()=>{if(advance(session))renderQuestion();else finishPractice();});});
function renderPendingResult(){
  const pending=pendingWords(session),pages=Math.max(1,Math.ceil(pending.length/2));resultPage=Math.max(0,Math.min(resultPage,pages-1));
  $('#result-pending-list').innerHTML=pending.slice(resultPage*2,resultPage*2+2).map(w=>'<button class="pending-chip" data-read-result="'+escape(w.id)+'" aria-label="查看待巩固词 '+escape(w.korean)+' 全文">'+escape(w.korean)+' · '+escape(w.chinese)+'</button>').join('');
  $('#result-pagination').hidden=pages<2;$('#result-page').textContent=(resultPage+1)+' / '+pages;
  $('#result-previous').disabled=resultPage===0;$('#result-next').disabled=resultPage===pages-1;
}
$('#result-previous').addEventListener('click',()=>{resultPage--;renderPendingResult();});
$('#result-next').addEventListener('click',()=>{resultPage++;renderPendingResult();});
$('#result-pending-list').addEventListener('click',event=>{const button=event.target.closest('[data-read-result]');if(button){const word=pendingWords(session).find(w=>w.id===button.dataset.readResult);readFull(word.korean+'\n\n'+word.chinese,'待巩固词全文');}});
function finishPractice() {
  const pending=pendingWords(session);
  $('#quiz-progress').style.width='100%';
  $('#result-title').textContent='练习完成';
  $('#result-score').textContent=session.correct+' / '+session.firstTotal; $('#result-pending').textContent=pending.length;
  resultPage=0;renderPendingResult();
  $('#retry-session').textContent=pending.length?'再练待巩固的词':'再练这一组';
  showView('result');renderHome();renderWords();window.scrollTo({top:0,behavior:'smooth'});
  loadWords({background:true}).catch(()=>{$('#sync-status').textContent='练习已保存，稍后刷新生词本。';});
}
function leaveQuiz(next='learn') {
  if(tab==='study'&&(studySaving||(studySavePayload&&$('#next-study').disabled))){toast(studySaving?'保存中，请稍候':'尚未保存，请重试');return;}
  if(tab==='quiz' && session && (saving || (answered && $('#next-question').disabled))) {toast(saving?'保存中，请稍候':'尚未保存，请重试');return;}
  session=null;studyCards=[];renderHome();renderWords();showView(next);refreshLocal();
}
$('#exit-quiz').addEventListener('click',()=>leaveQuiz());
$('#finish-session').addEventListener('click',()=>{session=null;showView('learn');refreshLocal();});
$('#retry-session').addEventListener('click',()=>{const pending=pendingWords(session);const group=(pending.length?pending:lastGroup).map(w=>words.find(item=>item.id===w.id)).filter(Boolean);startPractice(group,pending.length?'待巩固的词':lastLabel,{direct:true});});
$('#start-review').addEventListener('click',()=>{const due=dueWords().slice(0,10);if(!due.length){toast('暂无到期复习');return;}startPractice(due,'到期复习',{direct:true});});
$('#start-next').addEventListener('click',()=>{if(!words.length){showView('add');$('#lookup-input').focus();return;}const groups=groupsOf(words);const index=groups.findIndex(group=>group.some(w=>!w.masteryKo||!w.masteryZh));const selected=index<0?0:index;startPractice(groups[selected]||[],'第 '+(selected+1)+' 组');});
$('#group-grid').addEventListener('click',async event=>{
  if(event.target.closest('#add-first-word')){showView('add');$('#lookup-input').focus();window.scrollTo({top:0,behavior:'instant'});return;}
  if(event.target.closest('#start-picked-group')){const index=Number($('#group-picker').value);startPractice(groupsOf(words)[index],'第 '+(index+1)+' 组');return;}
  const samples=event.target.closest('#add-samples');if(!samples)return;samples.disabled=true;
  try { const data=await api('/api/words',{items:DICTIONARY.slice(0,10).map(({korean,chinese})=>({korean,chinese}))});await loadWords();toast('已添加 '+data.added+' 个词'); } catch(error){toast(error.message);samples.disabled=false;}
});
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{if(loading)return;if(tab==='quiz'||tab==='study')leaveQuiz(button.dataset.tab);else showView(button.dataset.tab);window.scrollTo({top:0,behavior:'instant'});if(tab==='add')focusLookup();}));
$('#add-from-library').addEventListener('click',()=>{showView('add');focusLookup();window.scrollTo({top:0,behavior:'smooth'});});
$('#word-search').addEventListener('input',()=>renderWords({resetScroll:true}));
$('#space-button').addEventListener('click',()=>{if(!currentSpace){toast('请先等待生词本打开。');return;}if(tab==='quiz'||tab==='study'||wordSaving||saving){toast('请先结束当前练习。');return;}$('#space-status').textContent='';refreshAudioSettings();$('#space-dialog').showModal();});
$('#export-data').addEventListener('click',async()=>{
  const dialog=$('#space-dialog');if(dialog.dataset.busy==='true')return;lockDialog(dialog,true);
  try{
    const backup=await localStore.exportBackup(),url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='春-生词本-'+new Date().toISOString().slice(0,10)+'.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
    $('#space-status').textContent='备份已导出';
  }catch(error){$('#space-status').textContent=error.message;}finally{lockDialog(dialog,false);}
});
$('#import-data').addEventListener('click',()=>$('#backup-file').click());
$('#backup-file').addEventListener('change',async event=>{
  const file=event.target.files?.[0],dialog=$('#space-dialog');if(!file)return;lockDialog(dialog,true);
  try{
    if(file.size>2*1024*1024)throw new Error('备份文件过大，请选择春导出的 JSON 文件。');
    let backup;try{backup=JSON.parse(await file.text());}catch{throw new Error('无法读取这份备份，请选择春导出的 JSON 文件。');}
    const result=await localStore.importBackup(backup);await loadWords();changes?.postMessage({spaceId:currentSpace.spaceId});
    $('#space-status').textContent='已导入 '+result.added+' 个词'+(result.skipped?'，跳过 '+result.skipped+' 个已有词':'');
  }catch(error){$('#space-status').textContent=error.message;}finally{event.target.value='';lockDialog(dialog,false);}
});
$('#prepare-offline').addEventListener('click',()=>setupOffline(true));
$('#import-original').addEventListener('click',async()=>{
  const dialog=$('#space-dialog');if(dialog.dataset.busy==='true')return;lockDialog(dialog,true);
  try{const result=await importOriginal($('#legacy-code').value);$('#space-status').textContent='已导入 '+result.added+' 个词'+(result.skipped?'，已有词保持原样':'');}
  catch(error){$('#space-status').textContent=error.message;}finally{lockDialog(dialog,false);}
});
function offlineMessage(worker,type){
  return new Promise((resolve,reject)=>{
    if(!worker||typeof MessageChannel!=='function'){reject(new Error('无法确认离线状态'));return;}
    const channel=new MessageChannel();
    const finish=(error,value)=>{clearTimeout(timer);channel.port1.close();channel.port2.close();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new Error('离线状态等待超时')),type==='SPRING_PREPARE_OFFLINE'?60000:3000);
    channel.port1.onmessage=event=>{
      const value=event.data;
      if(value?.type==='SPRING_OFFLINE_STATUS'&&typeof value.ready==='boolean')finish(null,value);
    };
    try{worker.postMessage({type},[channel.port2]);}catch(error){finish(error);}
  });
}
function waitForOfflineWorker(worker){
  if(!worker)return Promise.reject(new Error('离线资源尚未准备好'));
  if(worker.state==='activated')return Promise.resolve(worker);
  return new Promise((resolve,reject)=>{
    const finish=error=>{clearTimeout(timer);worker.removeEventListener('statechange',changed);error?reject(error):resolve(worker);};
    const changed=()=>{if(worker.state==='activated')finish();else if(worker.state==='redundant')finish(new Error('离线更新尚未完成'));};
    const timer=setTimeout(()=>finish(new Error('离线准备等待超时')),60000);
    worker.addEventListener('statechange',changed);changed();
  });
}
let offlineSetupSequence=0;
async function setupOffline(retry=false){
  const sequence=++offlineSetupSequence,label=$('#offline-status'),button=$('#prepare-offline');
  button.hidden=false;button.disabled=true;
  if(!('serviceWorker' in navigator)||!window.isSecureContext){label.textContent='此地址暂不支持离线打开';button.hidden=true;return;}
  label.textContent=retry?'正在检查更新…':'正在确认本机词典…';
  let registration;
  const showStatus=status=>{
    if(sequence!==offlineSetupSequence)return;
    label.textContent=status.ready?'词典与页面已保存到本机，可断网查词和练习':'本机资源不完整，请联网准备';
    button.textContent=status.ready?'检查更新':'联网准备';
    if(status.ready)navigator.storage?.persist?.().catch(()=>{});
    refreshAudioSettings();
  };
  try{
    // Reopening a prepared edition needs no configuration fetch or explicit SW
    // update request. The browser may still do its own small update checks.
    registration=await navigator.serviceWorker.getRegistration('/');
    if(sequence!==offlineSetupSequence)return;
    if(!registration)registration=await navigator.serviceWorker.register('/service-worker.js',{scope:'/',updateViaCache:'none'});
    else if(retry&&navigator.onLine)await registration.update();
    if(sequence!==offlineSetupSequence)return;
    const worker=await waitForOfflineWorker(registration.installing||registration.waiting||registration.active);
    if(sequence!==offlineSetupSequence)return;
    let status=await offlineMessage(worker,'SPRING_OFFLINE_STATUS');
    if(sequence!==offlineSetupSequence)return;
    if(!status.ready&&retry&&navigator.onLine){
      label.textContent='正在保存缺失的本机资源…';
      status=await offlineMessage(worker,'SPRING_PREPARE_OFFLINE');
      if(sequence!==offlineSetupSequence)return;
    }
    showStatus(status);
    if(status.ready&&retry&&!navigator.onLine)label.textContent='词典与页面已在本机，联网后可检查更新';
  }catch{
    // A failed new deployment must not hide a healthy previous offline edition.
    if(sequence!==offlineSetupSequence)return;
    let status;
    try{if(registration?.active?.state==='activated')status=await offlineMessage(registration.active,'SPRING_OFFLINE_STATUS');}catch{}
    if(sequence!==offlineSetupSequence)return;
    if(status?.ready){showStatus(status);label.textContent='当前版本可离线使用，更新尚未完成';}
    else if(sequence===offlineSetupSequence){label.textContent='离线资源尚未确认，请联网准备';button.textContent='联网准备';}
  }finally{if(sequence===offlineSetupSequence)button.disabled=false;}
}
document.querySelectorAll('[data-close-dialog]').forEach(button=>button.addEventListener('click',()=>{const dialog=button.closest('dialog');if(dialog.dataset.busy!=='true')dialog.close();}));
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('cancel',event=>{if(dialog.dataset.busy==='true')event.preventDefault();});
function lockDialog(dialog,busy){dialog.dataset.busy=String(busy);dialog.querySelectorAll('button,input').forEach(control=>control.disabled=busy);}
$('#word-list').addEventListener('click',event=>{
  const reading=event.target.closest('[data-read-word]');if(reading){const word=words.find(w=>w.id===reading.dataset.readWord);readFull(word.korean+'\n\n'+word.chinese,'生词全文');return;}
  const edit=event.target.closest('[data-edit]'), remove=event.target.closest('[data-delete]');
  if(edit){const word=words.find(w=>w.id===edit.dataset.edit);$('#edit-id').value=word.id;$('#edit-form').dataset.generation=word.generation;$('#edit-korean').value=word.korean;$('#edit-chinese').value=word.chinese;$('#edit-dialog').showModal();}
  if(remove){deleteId=remove.dataset.delete;const word=words.find(w=>w.id===deleteId);$('#delete-description').textContent=word.korean+' · '+word.chinese+'。它的答题记录也会移除。';$('#delete-dialog').showModal();}
});
$('#edit-form').addEventListener('submit',async event=>{
  event.preventDefault();const dialog=$('#edit-dialog');if(dialog.dataset.busy==='true')return;
  const id=$('#edit-id').value,pair={korean:$('#edit-korean').value,chinese:$('#edit-chinese').value,generation:$('#edit-form').dataset.generation};lockDialog(dialog,true);
  try{await api('/api/words/'+id,pair,'PATCH');dialog.close();await loadWords();toast('已修改');}catch(error){toast(error.message);}finally{lockDialog(dialog,false);}
});
$('#confirm-delete').addEventListener('click',async()=>{
  const dialog=$('#delete-dialog');if(dialog.dataset.busy==='true')return;const id=deleteId;lockDialog(dialog,true);
  try{await api('/api/words/'+id,undefined,'DELETE');dialog.close();await loadWords();toast('已移除');}catch(error){toast(error.message);}finally{lockDialog(dialog,false);}
});
$('#load-status').addEventListener('click',event=>{if(event.target.closest('#retry-load'))init();});
document.addEventListener('keydown',event=>{
  if(event.ctrlKey||event.metaKey||event.altKey||/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)||$('dialog[open]')||changingCard)return;
  if(event.key==='Enter'&&event.target.closest('button,a'))return;
  if(tab==='study'){if(/^[1-3]$/.test(event.key)&&studyConfidence===null){event.preventDefault();assessStudy(['known','maybe','unknown'][Number(event.key)-1]);}else if(event.key==='Enter'&&studyConfidence!==null){event.preventDefault();$('#next-study').click();}return;}
  if(tab!=='quiz')return;
  if(/^[1-4]$/.test(event.key)&&!answered){event.preventDefault();choose(Number(event.key)-1);}
  if(event.key==='Enter'&&answered&&!$('#next-question').disabled){event.preventDefault();$('#next-question').click();}
});
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-speak]');if(!button||button.disabled)return;
  const kind=button.dataset.speak,prefix=kind.startsWith('study')?'study':'quiz';
  const word=prefix==='study'?studyCards[studyIndex]:session?.queue[session.index]?.word;
  if(!word)return;
  const text=kind.endsWith('sentence')?$('#'+prefix+'-sentence').textContent:word.korean;
  audioRequest={word,text,button,recording:kind.endsWith('sentence')?null:word.recording};
  playAudio(audioRequest);
});
window.addEventListener('pagehide',stopAudio);
window.addEventListener('beforeunload',event=>{if(tab==='quiz'&&(saving||(answered&&$('#next-question').disabled))){event.preventDefault();event.returnValue='';}});
window.addEventListener('focus',refreshLocal);
window.addEventListener('online',()=>{lastRefresh=0;refreshLocal();});
window.addEventListener('offline',()=>{$('#sync-status').textContent='离线 · 词库与进度保存在此设备';});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAudio();else refreshLocal();});
changes?.addEventListener('message',()=>{lastRefresh=0;refreshLocal();});
if(document.modelContext?.registerTool) {
  const lifecycle=new AbortController();
  const tool={name:'lookup_korean_vocabulary',title:'查找中韩词义',description:'查找输入的韩文或中文对应的另一语种释义；不会加入生词本。',inputSchema:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:80}},required:['text'],additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},async execute(input){if(!input||typeof input.text!=='string'||!normalize(input.text)||input.text.length>80)throw new Error('请输入80字以内的韩文或中文。');const result=await api('/api/lookup',{text:input.text});if(tab!=='quiz'&&tab!=='study'){showView('add');lookupCache.set(normalize(input.text),result);await lookup(input.text);}return result;}};
  try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}
  window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
init();
