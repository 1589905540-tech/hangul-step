import {DatabaseSync} from 'node:sqlite';
import {readFileSync,existsSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
export function openDatabase(filename,migrations){
  if(filename!==':memory:')mkdirSync(resolve(filename,'..'),{recursive:true});
  const sql=new DatabaseSync(filename);sql.exec('PRAGMA journal_mode=WAL');sql.exec('PRAGMA busy_timeout=5000');
  sql.exec('CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY)');
  if(existsSync(migrations))for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql')).sort()){
    if(sql.prepare('SELECT name FROM _local_migrations WHERE name=?').get(name))continue;
    sql.exec('BEGIN');try{sql.exec(readFileSync(resolve(migrations,name),'utf8'));sql.prepare('INSERT INTO _local_migrations VALUES (?)').run(name);sql.exec('COMMIT');}catch(error){sql.exec('ROLLBACK');sql.close();throw error;}
  }
  const wrap=(statement,args=[])=>({bind(...values){return wrap(statement,values);},first(){return statement.get(...args)||null;},all(){return {results:statement.all(...args)};},run(){return {meta:{changes:Number(statement.run(...args).changes)}};}});
  const DB={prepare(query){return wrap(sql.prepare(query));},batch(statements){sql.exec('BEGIN');try{const result=statements.map(stmt=>stmt.run());sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}};
  return{sql,DB};
}
