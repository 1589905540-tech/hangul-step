import {createServer} from 'node:http';
import {networkInterfaces} from 'node:os';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDatabase} from './sqlite.mjs';
import {createBaiduTranslator} from './baidu.mjs';
const root=resolve(import.meta.dirname,'..');
export async function createStandaloneServer({filename=resolve(root,'data/learning.sqlite'),publicOrigin='',baiduAppId='',baiduSecret=''}={}){
  const {sql,DB}=openDatabase(filename,resolve(root,'drizzle'));
  const worker=(await import(pathToFileURL(resolve(root,'dist/server/index.js')))).default;
  const translate=baiduAppId&&baiduSecret?createBaiduTranslator({appId:baiduAppId,secret:baiduSecret}):undefined;
  const server=createServer(async(req,res)=>{
    try{
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>20000){res.writeHead(413,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'一次添加的内容太多。'}));return;}chunks.push(chunk);}
      const origin=publicOrigin||'http://'+req.headers.host;
      const url=new URL(req.url||'/',origin);
      if(url.origin!==new URL(origin).origin)throw new Error('Invalid request target');
      const headers=new Headers();for(const[key,value]of Object.entries(req.headers))if(value&&!key.startsWith('oai-authenticated-'))headers.set(key,Array.isArray(value)?value.join(','):value);
      const request=new Request(url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
      const response=await worker.fetch(request,{DB,translate});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'暂时无法完成，请重试。'}));}
  });
  server.requestTimeout=25000;server.headersTimeout=10000;
  return{server,sql,async close(){await new Promise(resolve=>server.close(resolve));sql.close();}};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const app=await createStandaloneServer({filename:process.env.DATA_FILE||resolve(root,'data/learning.sqlite'),publicOrigin:process.env.PUBLIC_ORIGIN||'',baiduAppId:process.env.BAIDU_APP_ID||'',baiduSecret:process.env.BAIDU_SECRET||''});
  const port=Number(process.env.PORT||4178),host=process.env.HOST||'127.0.0.1';
  app.server.listen(port,host,()=>{console.log('春 · 独立版，无需 GPT 登录');console.log('本机：http://127.0.0.1:'+port+'/');if(host==='0.0.0.0')for(const adapters of Object.values(networkInterfaces()))for(const item of adapters||[])if(item.family==='IPv4'&&!item.internal)console.log('局域网：http://'+item.address+':'+port+'/');});
  const stop=async()=>{await app.close();process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
