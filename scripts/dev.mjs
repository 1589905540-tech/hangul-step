import {createServer} from 'node:http';
import {readFileSync,existsSync,mkdirSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'..');
mkdirSync(resolve(root,'.dev'),{recursive:true});
const sql=new DatabaseSync(resolve(root,'.dev/learning.sqlite'));
sql.exec('CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY)');
if(existsSync(resolve(root,'drizzle'))){
  for(const name of readdirSync(resolve(root,'drizzle')).filter(n=>n.endsWith('.sql')).sort()){
    if(sql.prepare('SELECT name FROM _local_migrations WHERE name=?').get(name))continue;
    sql.exec('BEGIN');try{sql.exec(readFileSync(resolve(root,'drizzle',name),'utf8'));sql.prepare('INSERT INTO _local_migrations VALUES (?)').run(name);sql.exec('COMMIT');}catch(error){sql.exec('ROLLBACK');throw error;}
  }
}
function wrap(statement,params=[]){return {bind(...args){return wrap(statement,args);},async first(){return statement.get(...params)||null;},async all(){return {results:statement.all(...params)};},async run(){const r=statement.run(...params);return {success:true,meta:{changes:Number(r.changes)}};}};}
const DB={prepare(query){return wrap(sql.prepare(query));},async batch(statements){sql.exec('BEGIN');try{const results=[];for(const stmt of statements)results.push(await stmt.run());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}};
const built=spawnSync(process.execPath,['scripts/build.mjs'],{cwd:root,stdio:'inherit'});if(built.status!==0)process.exit(built.status||1);
const worker=(await import(pathToFileURL(resolve(root,'dist/server/index.js')))).default;
const port=Number(process.env.PORT||4178);
const server=createServer(async(req,res)=>{
  try{
    const body=[];for await(const chunk of req)body.push(chunk);
    const url='http://127.0.0.1:'+port+(req.url||'/');
    const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
    // Injected by the loopback-only preview server; production trusts Sites dispatch.
    headers.set('oai-authenticated-user-id','local-preview-owner');
    const request=new Request(url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(body)}:{})});
    const response=await worker.fetch(request,{DB});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){console.error(error);res.writeHead(500);res.end('Preview error');}
});
server.listen(port,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+port));
const stop=()=>server.close(()=>{sql.close();process.exit(0);});process.on('SIGINT',stop);process.on('SIGTERM',stop);
