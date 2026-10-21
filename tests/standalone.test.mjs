import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createStandaloneServer} from '../scripts/serve.mjs';
import {createBaiduTranslator} from '../scripts/baidu.mjs';
const root=resolve(import.meta.dirname,'..');
const start=async(filename)=>{const app=await createStandaloneServer({filename});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return{...app,url:'http://127.0.0.1:'+app.server.address().port};};
async function request(app,path,body,session,extra={}){
  const response=await fetch(app.url+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(session?{Cookie:session.cookie,'X-Learning-Space':session.spaceId}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  return{status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
test('standalone service stores personal data on disk across restart and restores into a new browser',async()=>{
  await mkdir(resolve(root,'artifacts'),{recursive:true});const directory=await mkdtemp(join(root,'artifacts','persistence-'));const filename=join(directory,'test.sqlite');
  let app=await start(filename);
  try{
    const first=await request(app,'/api/session');assert.equal(first.status,200);const identity={cookie:first.cookie,spaceId:first.body.spaceId};
    await request(app,'/api/words',{korean:'학교',chinese:'学校'},identity);
    const word=(await request(app,'/api/words',undefined,identity)).body.words[0];
    await request(app,'/api/answers',{id:'restart-answer-id',wordId:word.id,direction:'zh',correct:true,retry:false},identity);
    await app.close();app=await start(filename);
    const after=(await request(app,'/api/words',undefined,identity)).body.words[0];assert.equal(after.korean,'학교');assert.equal(after.masteryZh,1);
    const same=(await request(app,'/api/session',undefined,identity)).body;assert.equal(same.learningCode,first.body.learningCode);
    const restored=await request(app,'/api/session',{code:first.body.learningCode});assert.equal(restored.status,200);
    const recovered=await request(app,'/api/words',undefined,{cookie:restored.cookie,spaceId:restored.body.spaceId});assert.equal(recovered.body.words[0].id,word.id);
    const spoof=await request(app,'/api/session',undefined,undefined,{'oai-authenticated-user-id':identity.spaceId});assert.notEqual(spoof.body.spaceId,identity.spaceId);
  }finally{await app.close();}
});
test('domestic translation adapter keeps credentials server-side and uses official zh/kor language codes',async()=>{
  const seen=[];
  const translate=createBaiduTranslator({appId:'test-app-id',secret:'test-secret',fetcher:async(url,options)=>{const params=options.body;seen.push({url,from:params.get('from'),to:params.get('to'),sign:params.get('sign')});return Response.json({trans_result:[{dst:params.get('to')==='zh'?'雨伞':'우산'}]});}});
  assert.equal(await translate('우산',true),'雨伞');assert.equal(await translate('雨伞',false),'우산');assert.equal(seen[0].from,'kor');assert.equal(seen[0].to,'zh');assert.equal(seen[1].to,'kor');assert.match(seen[0].sign,/^[a-f0-9]{32}$/);
});
