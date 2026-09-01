import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { MemoryDatabase } from "../src/memory/database.js";
import { MemoryStore } from "../src/memory/store.js";
import { reconcileRegistry } from "../src/sync/supervisor.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

const run=promisify(execFile);
const env={...process.env,GIT_AUTHOR_NAME:"t",GIT_AUTHOR_EMAIL:"t@example.com",
  GIT_COMMITTER_NAME:"t",GIT_COMMITTER_EMAIL:"t@example.com"};

/** A minimal App Router repository, small enough to index inside a test. */
async function bareRepo(root:string,name:string):Promise<string> {
  const work=path.join(root,`${name}-work`);
  const bare=path.join(root,`${name}.git`);
  await mkdir(path.join(work,"src/app"),{recursive:true});
  await writeFile(path.join(work,"package.json"),
    JSON.stringify({name,dependencies:{next:"16.3.0",react:"19.2.8"}},null,2));
  await writeFile(path.join(work,"src/app/page.tsx"),"export default function Page(){ return null }\n");
  await run("git",["init","-q","-b","main",work],{env});
  await run("git",["-C",work,"add","."],{env});
  await run("git",["-C",work,"commit","-q","-m","first"],{env});
  await run("git",["clone","-q","--bare",work,bare],{env});
  // The work tree pushes into the bare repository, so a test can move upstream.
  await run("git",["-C",work,"remote","add","origin",bare],{env});
  return bare;
}

interface Fixture { root:string; memoryDb:MemoryDatabase; store:MemoryStore;
  write:(entries:unknown[])=>Promise<void>; bare:(name:string)=>Promise<string>; cleanup:()=>Promise<void> }

async function fixture():Promise<Fixture> {
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-supervisor-"));
  const registry=path.join(root,"repositories.json");
  const previousRegistry=process.env.MEMORY_REPOSITORIES_FILE;
  const previousWorkspace=process.env.MEMORY_WORKSPACE;
  process.env.MEMORY_REPOSITORIES_FILE=registry;
  process.env.MEMORY_WORKSPACE=path.join(root,"workspace");
  await writeFile(registry,JSON.stringify({repositories:[]}));

  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  return {
    root,memoryDb,store:new MemoryStore(memoryDb),
    write:async(entries)=>writeFile(registry,JSON.stringify({repositories:entries})),
    bare:(name)=>bareRepo(root,name),
    cleanup:async()=>{
      memoryDb.close();
      if (previousRegistry===undefined) delete process.env.MEMORY_REPOSITORIES_FILE; else process.env.MEMORY_REPOSITORIES_FILE=previousRegistry;
      if (previousWorkspace===undefined) delete process.env.MEMORY_WORKSPACE; else process.env.MEMORY_WORKSPACE=previousWorkspace;
      await rm(root,{recursive:true,force:true});
    },
  };
}

test("indexes a repository the moment the registry lists it",async()=>{
  const f=await fixture();
  try {
    await f.write([{name:"alpha",url:await f.bare("alpha"),mainBranch:"main"}]);
    const outcomes=await reconcileRegistry(f.memoryDb);
    assert.deepEqual(outcomes.map((item)=>item.action),["indexed"]);
    const indexed=f.store.getRepository("alpha");
    assert.ok(indexed?.last_indexed_sha,"a newly listed repository is cloned and indexed");
  } finally { await f.cleanup(); }
});

test("leaves an unchanged repository alone on the next pass",async()=>{
  const f=await fixture();
  try {
    await f.write([{name:"alpha",url:await f.bare("alpha"),mainBranch:"main"}]);
    await reconcileRegistry(f.memoryDb);
    const outcomes=await reconcileRegistry(f.memoryDb);
    assert.equal(outcomes[0]!.action,"synced");
    assert.equal((outcomes[0]!.detail as any).type,"NOOP","re-running must not re-analyse an unchanged repository");
  } finally { await f.cleanup(); }
});

test("retires a repository the registry stops listing, without destroying it",async()=>{
  const f=await fixture();
  try {
    await f.write([{name:"alpha",url:await f.bare("alpha"),mainBranch:"main"}]);
    await reconcileRegistry(f.memoryDb);

    await f.write([]);
    const outcomes=await reconcileRegistry(f.memoryDb);
    assert.deepEqual(outcomes.map((item)=>item.action),["retired"]);
    assert.equal(f.store.listRepositories().length,0,"retired repositories leave every surface");
    assert.equal(f.store.getRepository("alpha"),undefined);
    assert.deepEqual(f.store.listRetiredRepositories().map((item)=>item.name),["alpha"]);
    assert.ok(f.store.getRepository("alpha",{includeRetired:true}),"the rows are kept, so the edit is reversible");
  } finally { await f.cleanup(); }
});

test("restores a re-added repository instead of indexing it again",async()=>{
  const f=await fixture();
  try {
    const url=await f.bare("alpha");
    await f.write([{name:"alpha",url,mainBranch:"main"}]);
    await reconcileRegistry(f.memoryDb);
    const before=f.store.getRepository("alpha").last_indexed_at;

    await f.write([]);
    await reconcileRegistry(f.memoryDb);
    await f.write([{name:"alpha",url,mainBranch:"main"}]);
    const outcomes=await reconcileRegistry(f.memoryDb);

    assert.deepEqual(outcomes.map((item)=>item.action),["restored"]);
    assert.equal(f.store.getRepository("alpha").last_indexed_at,before,"a restore is not a re-index");
  } finally { await f.cleanup(); }
});

test("keeps a repository when retirement is switched off",async()=>{
  const f=await fixture();
  try {
    await f.write([{name:"alpha",url:await f.bare("alpha"),mainBranch:"main"}]);
    await reconcileRegistry(f.memoryDb);
    await f.write([]);
    const outcomes=await reconcileRegistry(f.memoryDb,{retireMissing:false});
    assert.deepEqual(outcomes,[]);
    assert.equal(f.store.listRepositories().length,1);
  } finally { await f.cleanup(); }
});

test("purges only a retired repository",async()=>{
  const f=await fixture();
  try {
    await f.write([{name:"alpha",url:await f.bare("alpha"),mainBranch:"main"}]);
    await reconcileRegistry(f.memoryDb);
    assert.equal(f.store.purgeRepository("alpha"),false,"a listed repository is never purged");

    await f.write([]);
    await reconcileRegistry(f.memoryDb);
    assert.equal(f.store.purgeRepository("alpha"),true);
    assert.equal(f.store.getRepository("alpha",{includeRetired:true}),undefined);
  } finally { await f.cleanup(); }
});

test("reports one broken entry without abandoning the others",async()=>{
  const f=await fixture();
  try {
    await f.write([
      {name:"broken",url:path.join(f.root,"does-not-exist.git"),mainBranch:"main"},
      {name:"alpha",url:await f.bare("alpha"),mainBranch:"main"},
    ]);
    const outcomes=await reconcileRegistry(f.memoryDb);
    const byName=Object.fromEntries(outcomes.map((item)=>[item.repository,item]));
    assert.equal(byName.broken!.action,"failed");
    assert.ok(byName.broken!.error);
    assert.equal(byName.alpha!.action,"indexed","a bad entry must not block a good one");
  } finally { await f.cleanup(); }
});

test("a registry edit settles membership without pulling commits",async()=>{
  const f=await fixture();
  try {
    const url=await f.bare("alpha");
    await f.write([{name:"alpha",url,mainBranch:"main"}]);
    await reconcileRegistry(f.memoryDb);
    const indexedSha=f.store.getRepository("alpha").last_indexed_sha;

    // Someone pushes upstream. No webhook fires.
    const work=path.join(f.root,"alpha-work");
    await writeFile(path.join(work,"src/app/page.tsx"),"export const dynamic='force-static';\nexport default function Page(){ return null }\n");
    await run("git",["-C",work,"commit","-qam","second"],{env});
    await run("git",["-C",work,"push","-q","origin","main"],{env});

    // The shape the file watcher uses: membership only.
    const outcomes=await reconcileRegistry(f.memoryDb,{syncExisting:false});
    assert.deepEqual(outcomes,[],"an unchanged registry means nothing to do");
    assert.equal(f.store.getRepository("alpha").last_indexed_sha,indexedSha,
      "commits are the webhook's job; a registry edit must not quietly re-index");

    // The explicit command still picks it up.
    const explicit=await reconcileRegistry(f.memoryDb,{syncExisting:true});
    assert.equal(explicit[0]!.action,"synced");
    assert.notEqual(f.store.getRepository("alpha").last_indexed_sha,indexedSha);
  } finally { await f.cleanup(); }
});

test("a repository added while commits are ignored is still indexed",async()=>{
  const f=await fixture();
  try {
    await f.write([{name:"alpha",url:await f.bare("alpha"),mainBranch:"main"}]);
    const outcomes=await reconcileRegistry(f.memoryDb,{syncExisting:false});
    assert.deepEqual(outcomes.map((item)=>item.action),["indexed"],
      "membership work happens whether or not commit checks are enabled");
  } finally { await f.cleanup(); }
});
