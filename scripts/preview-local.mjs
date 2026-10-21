import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const directory=resolve(import.meta.dirname,'../dist/public');
const types={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.webmanifest':'application/manifest+json'};
export function createLocalPreview(){
  return createServer(async(req,res)=>{
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
    try{
      const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      const file=resolve(directory,'.'+(pathname==='/'?'/index.html':pathname));
      if(!file.startsWith(directory+sep)||pathname.startsWith('/api/')){res.writeHead(404);res.end();return;}
      const body=await readFile(file);
      res.writeHead(200,{'Content-Type':(pathname==='/dictionary-license'?'text/html':types[extname(file)]||'application/octet-stream'),'Cache-Control':'public, no-cache','X-Content-Type-Options':'nosniff',...(pathname==='/service-worker.js'?{'Service-Worker-Allowed':'/'}:{})});
      res.end(req.method==='HEAD'?undefined:body);
    }catch{res.writeHead(404);res.end('Not found');}
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const port=Number(process.env.PORT||4182),server=createLocalPreview();
  server.listen(port,'127.0.0.1',()=>console.log('春 · 设备本地版预览 http://127.0.0.1:'+port+'/'));
  process.on('SIGINT',()=>server.close(()=>process.exit(0)));
}
