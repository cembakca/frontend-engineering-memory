import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { MemoryDatabase } from "../src/memory/database.js";
import { evaluateFreshness, loadFreshnessTargets, packFreshness } from "../src/retrieval/freshness.js";
import { configureTestNativeBinding } from "./native-binding.js";

const run=promisify(execFile);
await configureTestNativeBinding();

async function git(cwd:string,args:string[]):Promise<string> {
  const {stdout}=await run("git",["-C",cwd,...args],{env:{...process.env,
    GIT_AUTHOR_NAME:"t",GIT_AUTHOR_EMAIL:"t@example.com",GIT_COMMITTER_NAME:"t",GIT_COMMITTER_EMAIL:"t@example.com"}});
  return stdout.trim();
}

/** A registry pointing at a throwaway Git repository, so drift can actually be created. */
async function fixture():Promise<{root:string;repo:string;memoryDb:MemoryDatabase;cleanup:()=>Promise<void>}> {
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-fresh-"));
  const repo=path.join(root,"pilot");
  await mkdir(repo,{recursive:true});
  await git(repo,["init","-q","-b","main"]);
  await writeFile(path.join(repo,"a.txt"),"one\n");
  await git(repo,["add","."]);
  await git(repo,["commit","-q","-m","first"]);

  const registry=path.join(root,"repositories.json");
  await writeFile(registry,JSON.stringify({repositories:[{name:"pilot",path:repo,mainBranch:"main"}]}));
  const previousRegistry=process.env.MEMORY_REPOSITORIES_FILE;
  process.env.MEMORY_REPOSITORIES_FILE=registry;

  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  const head=await git(repo,["rev-parse","HEAD"]);
  memoryDb.db.prepare("INSERT INTO repositories(name,path,router_type,last_indexed_sha,last_indexed_at) VALUES(?,?,?,?,?)")
    .run("pilot",repo,"app",head,new Date().toISOString().replace("T"," ").slice(0,19));

  return {root,repo,memoryDb,cleanup:async()=>{
    memoryDb.close();
    if (previousRegistry===undefined) delete process.env.MEMORY_REPOSITORIES_FILE;
    else process.env.MEMORY_REPOSITORIES_FILE=previousRegistry;
    await rm(root,{recursive:true,force:true});
  }};
}

test("reports a clean, current snapshot as fresh",async()=>{
  const {memoryDb,cleanup}=await fixture();
  try {
    const report=await evaluateFreshness(memoryDb,"pilot");
    assert.equal(report.state,"fresh");
    assert.equal(report.driftCommits,0);
    assert.equal(report.workingTreeDirty,false);
    assert.equal(report.slo.drift,"met");
    assert.match(report.answerGuidance,/current commit/);
  } finally { await cleanup(); }
});

test("separates tree accuracy from snapshot freshness (RCE-N03)",async()=>{
  const {repo,memoryDb,cleanup}=await fixture();
  try {
    await writeFile(path.join(repo,"a.txt"),"one\nuncommitted\n");
    const report=await evaluateFreshness(memoryDb,"pilot");
    assert.equal(report.indexedSha,report.headSha,"the SHA still matches HEAD");
    assert.equal(report.state,"tree-dirty","an equal SHA is not the same as current");
    assert.equal(report.dirtyFileCount,1);
    assert.match(report.answerGuidance,/uncommitted/);
    assert.match(report.answerGuidance,/verify against source/);
  } finally { await cleanup(); }
});

test("counts drift when commits land after the index",async()=>{
  const {repo,memoryDb,cleanup}=await fixture();
  try {
    await writeFile(path.join(repo,"b.txt"),"two\n");
    await git(repo,["add","."]);
    await git(repo,["commit","-q","-m","second"]);
    await writeFile(path.join(repo,"c.txt"),"three\n");
    await git(repo,["add","."]);
    await git(repo,["commit","-q","-m","third"]);

    const report=await evaluateFreshness(memoryDb,"pilot");
    assert.equal(report.state,"behind");
    assert.equal(report.driftCommits,2);
    assert.equal(report.slo.drift,"warn","two commits is drift but not yet a breach");
    assert.match(report.answerGuidance,/2 commit\(s\) behind/);
  } finally { await cleanup(); }
});

test("breaches the drift target once the pipeline is clearly broken",async()=>{
  const {repo,memoryDb,cleanup}=await fixture();
  try {
    for (let index=0;index<10;index+=1) {
      await writeFile(path.join(repo,`f${index}.txt`),`${index}\n`);
      await git(repo,["add","."]);
      await git(repo,["commit","-q","-m",`c${index}`]);
    }
    const report=await evaluateFreshness(memoryDb,"pilot");
    assert.equal(report.driftCommits,10);
    assert.equal(report.slo.drift,"breach");
    assert.equal(report.slo.overall,"breach");
  } finally { await cleanup(); }
});

test("reports a never-indexed repository instead of implying emptiness is currency",async()=>{
  const {memoryDb,cleanup}=await fixture();
  try {
    memoryDb.db.prepare("UPDATE repositories SET last_indexed_sha=NULL WHERE name='pilot'").run();
    const report=await evaluateFreshness(memoryDb,"pilot");
    assert.equal(report.state,"never-indexed");
    assert.match(report.answerGuidance,/Never indexed/);
  } finally { await cleanup(); }
});

test("exposes a compact freshness block for every pack",async()=>{
  const {memoryDb,cleanup}=await fixture();
  try {
    const block=packFreshness(await evaluateFreshness(memoryDb,"pilot"));
    assert.deepEqual(Object.keys(block).sort(),["guidance","indexedSha","state"],
      "null fields are dropped; this block competes with facts for the same budget");
    assert.ok(String(block.guidance).length>0,"a pack must always carry the sentence its freshness demands");
  } finally { await cleanup(); }
});

test("loads the configured targets",async()=>{
  const targets=await loadFreshnessTargets();
  assert.equal(targets.mergeToIndexedLagSeconds.target,900);
  assert.equal(targets.reconciliationDriftCommits.breach,10);
});
