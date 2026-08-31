import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import Database from "better-sqlite3";
import { getHeadSha } from "../src/git/git.js";
import { MemoryDatabase } from "../src/memory/database.js";
import { MemoryStore } from "../src/memory/store.js";
import { hybridSearch } from "../src/retrieval/search.js";
import { fullIndex, incrementalSync } from "../src/sync/sync.js";
import type { RepositoryConfig } from "../src/types.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

const exec = promisify(execFile);
async function git(root:string,args:string[]){ await exec("git",["-C",root,...args]); }
async function source(root:string,relative:string,content:string){
  const target=path.join(root,relative);
  await mkdir(path.dirname(target),{recursive:true});
  await writeFile(target,content);
}

async function repository(): Promise<{root:string;config:RepositoryConfig}> {
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-sync-repo-"));
  await git(root,["init","-b","main"]);
  await git(root,["config","user.email","test@example.com"]);
  await git(root,["config","user.name","Test"]);
  await source(root,"package.json",JSON.stringify({dependencies:{next:"15.5.0",react:"19.1.0"}}));
  await source(root,"src/app/page.tsx","export default function Page(){ return null }\n");
  await git(root,["add","."]); await git(root,["commit","-m","first"]);
  return {root,config:{name:"fixture",path:root,mainBranch:"main",managedCheckout:false}};
}

test("incremental sync deactivates old memory versions and preserves their evidence",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const {root,config}=await repository();
  const dbRoot=await mkdtemp(path.join(os.tmpdir(),"fem-sync-db-"));
  const memoryDb=new MemoryDatabase(path.join(dbRoot,"memory.sqlite"));
  try {
    await fullIndex(config,memoryDb);
    const first=await getHeadSha(root);
    await source(root,"src/app/page.tsx","import { cookies } from 'next/headers'; export default async function Page(){ await cookies(); return null }\n");
    await git(root,["add","."]); await git(root,["commit","-m","dynamic"]);
    const second=await getHeadSha(root);
    await incrementalSync(config,memoryDb,{expectedCommit:second});

    const versions=memoryDb.db.prepare(`
      SELECT m.active,m.created_sha,m.removed_sha,e.file_path
      FROM memories m JOIN memory_evidence e ON e.memory_id=m.id
      WHERE m.subject='route:/' AND e.file_path='src/app/page.tsx' ORDER BY m.id
    `).all() as Array<{active:number;created_sha:string;removed_sha:string|null;file_path:string}>;
    assert.equal(versions.length,2);
    assert.deepEqual(versions[0],{active:0,created_sha:first,removed_sha:second,file_path:"src/app/page.tsx"});
    assert.deepEqual(versions[1],{active:1,created_sha:second,removed_sha:null,file_path:"src/app/page.tsx"});
    assert.equal((memoryDb.db.prepare("SELECT last_indexed_sha sha FROM repositories WHERE name='fixture'").get() as {sha:string}).sha,second);
  } finally {
    memoryDb.close();
    await rm(root,{recursive:true,force:true});
    await rm(dbRoot,{recursive:true,force:true});
  }
});

test("full index rolls every database mutation back when persistence fails",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const {root,config}=await repository();
  const dbRoot=await mkdtemp(path.join(os.tmpdir(),"fem-atomic-db-"));
  const memoryDb=new MemoryDatabase(path.join(dbRoot,"memory.sqlite"));
  const original=MemoryStore.prototype.insertPreparedMemories;
  MemoryStore.prototype.insertPreparedMemories=function(...args){
    original.apply(this,args);
    throw new Error("injected persistence failure");
  };
  try {
    await assert.rejects(()=>fullIndex(config,memoryDb),/injected persistence failure/);
    for (const table of ["repositories","routes","memories","index_runs"]) {
      const count=(memoryDb.db.prepare(`SELECT count(*) count FROM ${table}`).get() as {count:number}).count;
      assert.equal(count,0,`${table} must roll back`);
    }
  } finally {
    MemoryStore.prototype.insertPreparedMemories=original;
    memoryDb.close();
    await rm(root,{recursive:true,force:true});
    await rm(dbRoot,{recursive:true,force:true});
  }
});

test("migrates existing memory databases without discarding rows",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const dbRoot=await mkdtemp(path.join(os.tmpdir(),"fem-migration-db-"));
  const dbFile=path.join(dbRoot,"memory.sqlite");
  const nativeBinding=process.env.MEMORY_SQLITE_NATIVE_BINDING;
  const legacy=new Database(dbFile,nativeBinding ? {nativeBinding} : undefined);
  legacy.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository_id INTEGER NOT NULL,
      memory_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence TEXT NOT NULL,
      source_hash TEXT,
      created_sha TEXT,
      updated_sha TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO memories(repository_id,memory_type,subject,content,confidence) VALUES(1,'rendering','legacy','kept','verified');
  `);
  legacy.close();
  const memoryDb=new MemoryDatabase(dbFile);
  try {
    const columns=memoryDb.db.prepare("PRAGMA table_info(memories)").all() as Array<{name:string}>;
    assert.ok(columns.some((column)=>column.name==="removed_sha"));
    const routeColumns=memoryDb.db.prepare("PRAGMA table_info(routes)").all() as Array<{name:string}>;
    assert.ok(routeColumns.some((column)=>column.name==="backend_dependencies_json"));
    const tables=memoryDb.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>;
    assert.ok(tables.some((table)=>table.name==="route_dependencies"));
    assert.ok(tables.some((table)=>table.name==="index_run_changes"));
    assert.equal((memoryDb.db.prepare("SELECT content FROM memories WHERE subject='legacy'").get() as {content:string}).content,"kept");
  } finally {
    memoryDb.close();
    await rm(dbRoot,{recursive:true,force:true});
  }
});

test("reuses unchanged hashes, records changed_since audit and exposes route dependencies",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const {root,config}=await repository();
  const dbRoot=await mkdtemp(path.join(os.tmpdir(),"fem-p1-db-"));
  const memoryDb=new MemoryDatabase(path.join(dbRoot,"memory.sqlite"));
  const store=new MemoryStore(memoryDb);
  try {
    await source(root,"src/app/dashboard/page.tsx","import { loadAccounts } from './service'; export default async function Page(){ await loadAccounts(); return null }\n");
    await source(root,"src/app/dashboard/service.ts","export async function loadAccounts(){ return fetch(process.env.ACCOUNTS_API + '/accounts',{cache:'force-cache'}) }\n");
    await git(root,["add","."]); await git(root,["commit","-m","dashboard"]);
    const indexedSha=await getHeadSha(root);

    const first=await fullIndex(config,memoryDb) as {memoriesCreated:number};
    assert.ok(first.memoriesCreated>0);
    assert.equal((memoryDb.db.prepare("SELECT COUNT(*) count FROM memory_evidence WHERE commit_sha=?").get(indexedSha) as {count:number}).count>0,true);
    const activeBefore=(memoryDb.db.prepare("SELECT id FROM memories WHERE active=1 ORDER BY id").all() as Array<{id:number}>).map((row)=>row.id);
    assert.ok(store.listRouteDependencies("fixture","/dashboard").some((row:any)=>row.dependency_type==="http"));

    const second=await fullIndex(config,memoryDb) as {memoriesCreated:number;memoriesReused:number};
    const activeAfter=(memoryDb.db.prepare("SELECT id FROM memories WHERE active=1 ORDER BY id").all() as Array<{id:number}>).map((row)=>row.id);
    assert.equal(second.memoriesCreated,0);
    assert.equal(second.memoriesReused,activeBefore.length);
    assert.deepEqual(activeAfter,activeBefore);

    const nextResults=await hybridSearch(memoryDb,"Next.js 15 repositories",{limit:5});
    assert.ok(nextResults.some((result)=>result.repository==="fixture" && result.channels.includes("sql")));
    const routeResults=await hybridSearch(memoryDb,"route /dashboard?",{limit:5});
    assert.ok(routeResults.some((result)=>result.subject==="route:/dashboard" && result.channels.includes("sql")));

    await source(root,"src/app/dashboard/service.ts","import { headers } from 'next/headers'; export async function loadAccounts(){ await headers(); return fetch(process.env.ACCOUNTS_API + '/accounts',{cache:'no-store'}) }\n");
    await git(root,["add","."]); await git(root,["commit","-m","dynamic dashboard"]);
    const changedSha=await getHeadSha(root);
    await incrementalSync(config,memoryDb,{expectedCommit:changedSha});
    const changes=store.listMemoryChanges("fixture",indexedSha) as Array<{operation:string;source_file:string|null}>;
    assert.ok(changes.some((change)=>change.operation==="DEACTIVATE" && change.source_file==="src/app/dashboard/service.ts"));
    assert.ok(changes.some((change)=>change.operation==="CREATE"));
    assert.ok(changes.every((change)=>change.operation!=="REUSE"));
    assert.deepEqual(store.listMemoryChanges("fixture",changedSha),[]);
  } finally {
    memoryDb.close();
    await rm(root,{recursive:true,force:true});
    await rm(dbRoot,{recursive:true,force:true});
  }
});
