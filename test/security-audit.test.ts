import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { runSecurityAudit } from "../src/security/audit.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

const SECRET="s3cr3t-gateway-token-9f2b";

/**
 * Each invariant is proven by breaking it. An audit that has never been seen to
 * fail is indistinguishable from an audit that cannot fail.
 */
async function fixture():Promise<{repo:string;memoryDb:MemoryDatabase;cleanup:()=>Promise<void>}> {
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-audit-"));
  const repo=path.join(root,"pilot");
  await mkdir(repo,{recursive:true});
  await writeFile(path.join(repo,".env.production"),`GATEWAY_URL=${SECRET}\nEMPTY=\n`);

  const registry=path.join(root,"repositories.json");
  await writeFile(registry,JSON.stringify({repositories:[{name:"pilot",path:repo,mainBranch:"main"}]}));
  const previous=process.env.MEMORY_REPOSITORIES_FILE;
  process.env.MEMORY_REPOSITORIES_FILE=registry;

  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  memoryDb.db.prepare("INSERT INTO repositories(name,path,router_type,last_indexed_sha) VALUES(?,?,?,?)")
    .run("pilot",repo,"app","a".repeat(40));
  return {repo,memoryDb,cleanup:async()=>{
    memoryDb.close();
    if (previous===undefined) delete process.env.MEMORY_REPOSITORIES_FILE; else process.env.MEMORY_REPOSITORIES_FILE=previous;
    await rm(root,{recursive:true,force:true});
  }};
}

function invariant(report:Awaited<ReturnType<typeof runSecurityAudit>>,id:string) {
  const found=report.invariants.find((item)=>item.id===id);
  assert.ok(found,`missing invariant ${id}`);
  return found!;
}

function addMemory(memoryDb:MemoryDatabase,content:string,options:{producer?:string;quality?:number|null;confidence?:string;evidence?:string|null}={}):number {
  const row=memoryDb.db.prepare(
    "INSERT INTO memories(repository_id,memory_type,subject,content,confidence,producer,quality_score,created_sha,updated_sha) VALUES(1,'configuration','GATEWAY_URL',?,?,?,?,?,?)",
  ).run(content,options.confidence ?? "verified",options.producer ?? "deterministic",options.quality ?? null,"a".repeat(40),"a".repeat(40));
  const id=Number(row.lastInsertRowid);
  if (options.evidence!==null) {
    memoryDb.db.prepare("INSERT INTO memory_evidence(memory_id,file_path,start_line,end_line,commit_sha) VALUES(?,?,?,?,?)")
      .run(id,options.evidence ?? "src/lib/gateway.ts",9,9,"a".repeat(40));
  }
  return id;
}

test("passes a clean database on every invariant",async()=>{
  const {memoryDb,cleanup}=await fixture();
  try {
    addMemory(memoryDb,"Configuration key GATEWAY_URL is referenced by src/lib/gateway.ts.");
    const report=await runSecurityAudit(memoryDb,{repository:"pilot"});
    assert.equal(report.ok,true,JSON.stringify(report.invariants.filter((item)=>item.status==="fail")));
    assert.equal(invariant(report,"I1-no-env-values").status,"pass");
  } finally { await cleanup(); }
});

test("I1 catches an env value stored as a fact",async()=>{
  const {memoryDb,cleanup}=await fixture();
  try {
    addMemory(memoryDb,`GATEWAY_URL is set to ${SECRET} in production.`);
    const report=await runSecurityAudit(memoryDb,{repository:"pilot"});
    const result=invariant(report,"I1-no-env-values");
    assert.equal(result.status,"fail");
    assert.ok(result.findings.some((finding)=>finding.includes("memories")));
    assert.equal(report.ok,false);
  } finally { await cleanup(); }
});

test("I2 catches evidence that escapes the repository",async()=>{
  const {memoryDb,cleanup}=await fixture();
  try {
    addMemory(memoryDb,"a fact",{evidence:"/etc/passwd"});
    const result=invariant(await runSecurityAudit(memoryDb,{repository:"pilot"}),"I2-indexed-paths-inside-registry");
    assert.equal(result.status,"fail");
    assert.ok(result.findings.some((finding)=>finding.includes("/etc/passwd")));
  } finally { await cleanup(); }
});

test("I2 catches an indexed repository that is not in the registry",async()=>{
  const {memoryDb,cleanup}=await fixture();
  try {
    memoryDb.db.prepare("INSERT INTO repositories(name,path,router_type) VALUES('ghost','/ghost','app')").run();
    const result=invariant(await runSecurityAudit(memoryDb,{repository:"pilot"}),"I2-indexed-paths-inside-registry");
    assert.equal(result.status,"fail");
    assert.ok(result.findings.some((finding)=>finding.includes("ghost")));
  } finally { await cleanup(); }
});

test("I3 catches an AI memory that is unlabelled or unevidenced",async()=>{
  const {memoryDb,cleanup}=await fixture();
  try {
    addMemory(memoryDb,"an interpretation",{producer:"ai-extractor",quality:null,confidence:"verified"});
    const result=invariant(await runSecurityAudit(memoryDb,{repository:"pilot"}),"I3-ai-memories-labelled");
    assert.equal(result.status,"fail");
    assert.ok(result.findings.some((finding)=>finding.includes("quality score")));
  } finally { await cleanup(); }
});

test("I4 catches fact content copied into telemetry",async()=>{
  const {memoryDb,cleanup}=await fixture();
  try {
    const content="GATEWAY_URL configures the internal cluster gateway used by every upstream call.";
    addMemory(memoryDb,content);
    memoryDb.db.prepare(
      "INSERT INTO retrieval_events(repository_id,tool,query_hash,query_shape_json,gaps_json) VALUES(1,'memory_context','h','{}',?)",
    ).run(JSON.stringify([content]));
    const result=invariant(await runSecurityAudit(memoryDb,{repository:"pilot"}),"I4-telemetry-carries-no-content");
    assert.equal(result.status,"fail");
  } finally { await cleanup(); }
});

test("I5 catches deactivated memories held past the retention window",async()=>{
  const {memoryDb,cleanup}=await fixture();
  try {
    const id=addMemory(memoryDb,"an old fact");
    memoryDb.db.prepare("UPDATE memories SET active=0, updated_at=datetime('now','-200 days') WHERE id=?").run(id);
    const result=invariant(await runSecurityAudit(memoryDb,{repository:"pilot"}),"I5-retention-within-policy");
    assert.equal(result.status,"fail");
    assert.ok(result.findings.some((finding)=>finding.includes("retention")||finding.includes("day window")));
  } finally { await cleanup(); }
});

test("reports skipped rather than passing when it cannot check",async()=>{
  const {repo,memoryDb,cleanup}=await fixture();
  try {
    await rm(path.join(repo,".env.production"));
    const result=invariant(await runSecurityAudit(memoryDb,{repository:"pilot"}),"I1-no-env-values");
    assert.equal(result.status,"skipped","an unmeasurable rule is never reported as passing");
    assert.equal((await runSecurityAudit(memoryDb,{repository:"pilot"})).skipped,1);
  } finally { await cleanup(); }
});
