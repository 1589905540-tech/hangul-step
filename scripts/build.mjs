import { readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const read = path => readFile(resolve(root, path), 'utf8');
const [worker, page, baseStyle, referenceStyle, client, core, dictionary, examples, icon] = await Promise.all(['worker/index.js','src/index.html','src/styles.css','src/reference.css','src/app.mjs','src/core.mjs','src/dictionary.mjs','src/examples.mjs','src/icon.svg'].map(read));
const background=(await readFile(resolve(root,'src/assets/coast-v1.webp'))).toString('base64');
const tabletCover=(await readFile(resolve(root,'src/assets/coast-ipad-v2.webp'))).toString('base64');
const bilingualBytes=await readFile(resolve(root,'src/data/krdict-ko-zh-202609.json'));
const bilingual=gzipSync(bilingualBytes).toString('base64');
// Prepare the reverse index at build time; Korean lookups never load it.
const byKorean=JSON.parse(bilingualBytes);
const byChinese=Object.create(null);
for(const [korean,senses] of Object.entries(byKorean))senses.forEach((chinese,index)=>{
  const variants=new Set([chinese,...chinese.split(/[，,、；;]/)].map(value=>value.normalize('NFC').trim().replace(/\s+/g,' ')).filter(Boolean));
  for(const variant of variants)(byChinese[variant]??=[]).push([korean,index]);
});
const reverse=gzipSync(JSON.stringify(byChinese)).toString('base64');
const license=await read('src/dictionary-license.html');
const dictionarySource=await read('src/data/krdict-source.json');
const viewportStyle=await read('src/viewport.css');
const ipadStyle=await read('src/ipad-layout.css');
const ipadHomeStyle=await read('src/ipad-home.css');
const pronunciation=await read('src/pronunciation.mjs');
const recordedAudio=await read('src/recorded-audio.mjs');
const wordAudio=await read('src/word-audio.mjs');
const pronunciationLinks=gzipSync(await readFile(resolve(root,'src/data/krdict-pronunciation-links.json'))).toString('base64');
const pronunciationSource=await read('src/data/krdict-pronunciation-source.json');
const localStore=await read('src/local-store.mjs');
const syncProtocol=await read('sync/protocol.mjs');
const offlineLookup=await read('src/offline-lookup.mjs');
const lookupRanking=await read('src/lookup-ranking.mjs');
const priorityBytes=await readFile(resolve(root,'src/data/krdict-lookup-priority.json'));
const priorityMetadata=JSON.parse(priorityBytes);
const lookupPriority=gzipSync(priorityBytes).toString('base64');
const dictionarySha256=createHash('sha256').update(bilingualBytes).digest('hex');
if(priorityMetadata.schemaVersion!==1 || priorityMetadata.dictionarySha256!==dictionarySha256)throw new Error('Lookup priority data does not match this dictionary');
const swSource=await read('src/service-worker.js');
const icons=Object.fromEntries(await Promise.all([180,192,512].map(async size=>['/chun-icon-'+size+'.png',(await readFile(resolve(root,'src/assets/chun-icon-'+size+'.png'))).toString('base64')])));
const style=[baseStyle,referenceStyle,viewportStyle,ipadStyle,ipadHomeStyle].join('\n');
const appConfig=JSON.stringify({mode:'local',legacyImport:false});
const manifest=JSON.stringify({name:'春 · 韩语生词本',short_name:'春',start_url:'/',display:'standalone',background_color:'#d8dfd0',theme_color:'#d8dfd0',lang:'zh-CN',icons:[{src:'/chun-icon-192.png',sizes:'192x192',type:'image/png',purpose:'any maskable'},{src:'/chun-icon-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}]});
// Preserve dictionary bytes so older installed copies can pass the new hashes.
const publicFiles={'index.html':page,'styles.css':style,'app.mjs':client,'core.mjs':core,'dictionary.mjs':dictionary,'examples.mjs':examples,'pronunciation.mjs':pronunciation,'recorded-audio.mjs':recordedAudio,'word-audio.mjs':wordAudio,'local-store.mjs':localStore,'sync/protocol.mjs':syncProtocol,'offline-lookup.mjs':offlineLookup,'lookup-ranking.mjs':lookupRanking,'icon.svg':icon,'dictionary-license':license,'app-config.json':appConfig,'manifest.webmanifest':manifest,'krdict-ko-zh-202609.json':bilingualBytes,'krdict-lookup-priority.json':priorityBytes,'krdict-source.json':dictionarySource,'krdict-pronunciation-source.json':pronunciationSource,'coast-v1.webp':Buffer.from(background,'base64')};
publicFiles['coast-ipad-v2.webp']=Buffer.from(tabletCover,'base64');
for(const [path,encoded] of Object.entries(icons))publicFiles[path.slice(1)]=Buffer.from(encoded,'base64');
const pathsBlock=/const STATIC_PATHS\s*=\s*\[([\s\S]*?)\];/.exec(swSource);
if(!pathsBlock)throw new Error('Missing service worker static resource list');
const staticPaths=[...pathsBlock[1].matchAll(/['"]([^'"]+)['"]/g)].map(match=>match[1]);
const assetHashes=Object.fromEntries(staticPaths.map(path=>{
  const name=path==='/'?'index.html':path.slice(1);
  if(!Object.hasOwn(publicFiles,name))throw new Error('Missing service worker resource: '+path);
  return [path,createHash('sha256').update(publicFiles[name]).digest('hex')];
}));
const hashPlaceholder='/*__ASSET_HASHES__*/ {}';
if(swSource.split(hashPlaceholder).length!==2)throw new Error('Expected one service worker asset hash placeholder');
const version=createHash('sha256').update(swSource).update(JSON.stringify(assetHashes)).digest('hex').slice(0,16);
const serviceWorker=swSource.replaceAll('__ASSET_VERSION__',version).replace(hashPlaceholder,JSON.stringify(assetHashes));
publicFiles['service-worker.js']=serviceWorker;
const definitions = Object.entries({PAGE:page,STYLE:style,CLIENT:client,CORE:core,PRONUNCIATION:pronunciation,RECORDED_AUDIO:recordedAudio,WORD_AUDIO:wordAudio,LOCAL_STORE:localStore,SYNC_PROTOCOL:syncProtocol,OFFLINE_LOOKUP:offlineLookup,LOOKUP_RANKING:lookupRanking,LOOKUP_PRIORITY_GZIP:lookupPriority,SERVICE_WORKER:serviceWorker,APP_CONFIG_SOURCE:appConfig,MANIFEST_SOURCE:manifest,PRONUNCIATION_LINKS_GZIP:pronunciationLinks,PRONUNCIATION_SOURCE:pronunciationSource,DICTIONARY_SOURCE:dictionary,EXAMPLES_SOURCE:examples,BACKGROUND:background,TABLET_COVER:tabletCover,ICON:icon,APP_ICONS:icons,BILINGUAL_GZIP:bilingual,REVERSE_GZIP:reverse,DICTIONARY_LICENSE:license,KRDICT_SOURCE:dictionarySource}).map(([key,value]) => 'const ' + key + ' = ' + JSON.stringify(value) + ';').join('\n');
await mkdir(resolve(root, 'dist/server'), {recursive:true});
await mkdir(resolve(root, 'dist/.openai'), {recursive:true});
await writeFile(resolve(root,'dist/server/index.js'), definitions + '\n' + dictionary.replace(/export /g, '') + '\n' + lookupRanking.replace(/export /g, '') + '\n' + worker);
await cp(resolve(root,'.openai/hosting.json'), resolve(root,'dist/.openai/hosting.json'));
// A static device edition needs no login, database server or private API keys.
await mkdir(resolve(root,'dist/public/sync'),{recursive:true});
await Promise.all(Object.entries(publicFiles).map(([name,value])=>writeFile(resolve(root,'dist/public',name),value)));
// Remove only this obsolete generated index; the source and legacy server route
// remain available, but a new local installation must never download it.
await rm(resolve(root,'dist/public/krdict-pronunciation-links.json'),{force:true});
await rm(resolve(root,'dist/public/spring-ipad-v1.svg'),{force:true});
console.log('Built Worker and static local edition, offline version '+version+'.');
