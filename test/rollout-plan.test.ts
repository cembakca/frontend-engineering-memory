import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { evaluateRollout } from "../src/rollout/rollout-plan.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

const run=promisify(execFile);

/** Real repositories, because an unmeasurable freshness state is itself below the health floor. */
async function initRepo(dir:string):Promise<string> {
  const env={...process.env,GIT_AUTHOR_NAME:"t",GIT_AUTHOR_EMAIL:"t@example.com",GIT_COMMITTER_NAME:"t",GIT_COMMITTER_EMAIL:"t@example.com"};
  await run("git",["-C",dir,"init","-q","-b","main"],{env});
  await writeFile(path.join(dir,"a.txt"),"one\n");
  await run("git",["-C",dir,"add","."],{env});
  await run("git",["-C",dir,"commit","-q","-m","first"],{env});
  return (await run("git",["-C",dir,"rev-parse","HEAD"],{env})).stdout.trim();
}

const OPEN_GATE={decision:"open",blockers:[]};

/** A repository whose facts are canonical enough to clear the health floor. */
function healthyMemory(memoryDb:MemoryDatabase,repositoryId:number,subject:string):void {
  const row=memoryDb.db.prepare(
    "INSERT INTO memories(repository_id,memory_type,subject,content,confidence,created_sha,updated_sha) VALUES(?,'configuration',?,?,'verified',?,?)",
  ).run(repositoryId,subject,`${subject} is read at src/lib/gateway.ts.`,"a".repeat(40),"a".repeat(40));
  memoryDb.db.prepare("INSERT INTO memory_evidence(memory_id,file_path,start_line,end_line,commit_sha) VALUES(?,?,?,?,?)")
    .run(Number(row.lastInsertRowid),"src/lib/gateway.ts",9,9,"a".repeat(40));
}

async function fixture(names:string[]=["pilot"]):Promise<{root:string;memoryDb:MemoryDatabase;cleanup:()=>Promise<void>}> {
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-rollout-"));
  const registryEntries=[];
  const heads=new Map<string,string>();
  for (const name of names) {
    const repo=path.join(root,name);
    await mkdir(repo,{recursive:true});
    heads.set(name,await initRepo(repo));
    registryEntries.push({name,path:repo,mainBranch:"main"});
  }
  const registry=path.join(root,"repositories.json");
  await writeFile(registry,JSON.stringify({repositories:registryEntries}));
  const previous=process.env.MEMORY_REPOSITORIES_FILE;
  process.env.MEMORY_REPOSITORIES_FILE=registry;

  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  names.forEach((name,index)=>{
    memoryDb.db.prepare("INSERT INTO repositories(name,path,router_type,last_indexed_sha) VALUES(?,?,?,?)")
      .run(name,path.join(root,name),"app",heads.get(name));
    healthyMemory(memoryDb,index+1,`KEY_${index}`);
  });
  return {root,memoryDb,cleanup:async()=>{
    memoryDb.close();
    if (previous===undefined) delete process.env.MEMORY_REPOSITORIES_FILE; else process.env.MEMORY_REPOSITORIES_FILE=previous;
    await rm(root,{recursive:true,force:true});
  }};
}

test("holds while the acceptance gate is blocked, whatever the repositories look like",async()=>{
  const {memoryDb,cleanup}=await fixture();
  try {
    const report=await evaluateRollout(memoryDb,{gate:{decision:"blocked",blockers:["retrieval.recall: 0.54"]}});
    assert.equal(report.decision,"hold");
    assert.ok(report.blockers.some((item)=>item.includes("acceptance gate is blocked")));
  } finally { await cleanup(); }
});

test("holds when an already-onboarded repository regressed, even with an open gate",async()=>{
  const {memoryDb,cleanup}=await fixture(["pilot","second"]);
  try {
    // Duplicate the same subject so the canonical duplication ratio rises past the floor.
    for (let index=0;index<9;index+=1) healthyMemory(memoryDb,1,"KEY_0");
    const report=await evaluateRollout(memoryDb,{gate:OPEN_GATE});
    assert.equal(report.decision,"hold");
    const pilot=report.repositories.find((item)=>item.repository==="pilot");
    assert.equal(pilot?.healthy,false);
    assert.ok(pilot?.reasons.some((reason)=>reason.includes("duplication")));
    assert.ok(report.repositories.find((item)=>item.repository==="second")?.healthy,
      "a healthy repository is not blamed for another one's regression");
  } finally { await cleanup(); }
});

test("advances when the gate is open, every repository is healthy and cost is in budget",async()=>{
  const {memoryDb,cleanup}=await fixture();
  try {
    const report=await evaluateRollout(memoryDb,{gate:OPEN_GATE});
    assert.deepEqual(report.blockers,[]);
    assert.equal(report.decision,"advance");
    assert.equal(report.currentWave?.name,"pilot");
    assert.equal(report.nextWave?.name,"diversity");
  } finally { await cleanup(); }
});

test("places the registry on the right wave as it grows",async()=>{
  const {memoryDb,cleanup}=await fixture(["a","b","c","d"]);
  try {
    const report=await evaluateRollout(memoryDb,{gate:OPEN_GATE});
    assert.equal(report.currentCount,4);
    assert.equal(report.currentWave?.name,"squad");
    assert.equal(report.nextWave?.name,"division");
  } finally { await cleanup(); }
});

test("holds when an indexed repository is missing from the registry",async()=>{
  const {memoryDb,cleanup}=await fixture();
  try {
    memoryDb.db.prepare("INSERT INTO repositories(name,path,router_type,last_indexed_sha) VALUES('ghost','/ghost','app',?)")
      .run("a".repeat(40));
    const report=await evaluateRollout(memoryDb,{gate:OPEN_GATE});
    assert.equal(report.decision,"hold");
    assert.ok(report.blockers.some((item)=>item.includes("not in the registry")));
  } finally { await cleanup(); }
});

test("measures operating cost rather than estimating it",async()=>{
  const {memoryDb,cleanup}=await fixture();
  try {
    const report=await evaluateRollout(memoryDb,{gate:OPEN_GATE});
    assert.ok((report.operatingCost.databaseBytes ?? 0)>0,"database size is read from disk");
    assert.equal(report.operatingCost.databaseBytesPerRepository,report.operatingCost.databaseBytes,
      "one repository means the per-repository cost equals the total");
  } finally { await cleanup(); }
});
