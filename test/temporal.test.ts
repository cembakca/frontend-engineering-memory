import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { GraphEdge } from "../src/analyzers/symbol-graph.js";
import { MemoryDatabase } from "../src/memory/database.js";
import { ownershipMatrix } from "../src/memory/ownership.js";
import { MemoryStore } from "../src/memory/store.js";
import { buildDecisionContext, isDecisionQuestion } from "../src/retrieval/decision-context.js";
import { diffBehaviorSnapshots, TemporalContextEngine, type RepositorySnapshot } from "../src/retrieval/temporal.js";
import { TaskContextCompiler } from "../src/retrieval/task-context.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

const SHA_A="a".repeat(40); const SHA_B="b".repeat(40);
const edge=(type:GraphEdge["type"],from:string,to:string,line=1):GraphEdge=>({type,from,fromKind:"symbol",to,toKind:type==="reads" ? "config" : "backend-endpoint",filePath:"src/api.ts",symbol:"load",startLine:line,confidence:"observed"});

function snapshot(sha:string,variant:"before"|"after"):RepositorySnapshot {
  return {repository:"fixture",sha,profile:{router:"app"},routes:[{route:"/",routeType:"page",sourceFile:"src/page.tsx",
    rendering:variant==="before" ? "static" : "dynamic-ssr",authRequired:null,middlewareMatched:false,
    cache:variant==="before" ? ["revalidate=60"] : ["no-store"],dataSources:[],backendDependencies:[],seoType:"static",metadataSource:null}],
    dependencies:[],memories:[{type:"configuration",subject:"API_URL",content:variant==="before" ? "old behavior" : "new behavior",confidence:"verified",evidence:["src/api.ts"]}],
    graph:variant==="before" ? [edge("reads","src/api.ts#load","OLD_URL"),edge("fetches","src/api.ts#load","GET /v1")]
      : [edge("reads","src/api.ts#load","API_URL"),edge("fetches","src/api.ts#load","GET /v2")]};
}

test("diffs route, flow, config, API and fact behavior across indexed SHAs",()=>{
  const result=diffBehaviorSnapshots(snapshot(SHA_A,"before"),snapshot(SHA_B,"after"));
  assert.equal(result.kind,"behavior-diff");
  assert.equal(result.routeChanges[0].fields.rendering.to,"dynamic-ssr");
  assert.ok(result.flowChanges.some((item:any)=>item.relation==="fetches"&&item.to==="GET /v2"));
  assert.ok(result.configChanges.some((item:any)=>item.target==="API_URL"));
  assert.ok(result.apiChanges.some((item:any)=>item.target==="GET /v2"));
  assert.equal(result.factChanges[0].change,"changed");
  const bounded=diffBehaviorSnapshots(snapshot(SHA_A,"before"),snapshot(SHA_B,"after"),1_000);
  assert.ok(JSON.stringify(bounded).length<=1_000);
  assert.equal(bounded.answerContract.uncertainty.level,"partial");
});

test("returns a bounded fact and graph view for one indexed SHA",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-temporal-"));
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  try {
    memoryDb.db.prepare("INSERT INTO repositories(name,path) VALUES('fixture','/fixture')").run();
    const value=snapshot(SHA_A,"before");
    memoryDb.db.prepare(`INSERT INTO repository_snapshots(repository_id,sha,profile_json,routes_json,dependencies_json,memories_json,graph_json)
      VALUES(1,?,?,?,?,?,?)`).run(SHA_A,JSON.stringify(value.profile),JSON.stringify(value.routes),JSON.stringify(value.dependencies),JSON.stringify(value.memories),JSON.stringify(value.graph));
    const result=await new TaskContextCompiler(memoryDb).compile("API_URL load",{repository:"fixture",atSha:SHA_A,maxChars:1_200});
    assert.equal(result.kind,"point-in-time");
    assert.equal(result.snapshotSha,SHA_A);
    assert.equal(result.facts[0].subject,"API_URL");
    assert.ok(result.relations.some((item:GraphEdge)=>item.type==="reads"));
    assert.ok(JSON.stringify(result).length<=1_200);
  } finally { memoryDb.close(); await rm(root,{recursive:true,force:true}); }
});

test("stores only approved decision provenance and supersedes older rationale",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-decisions-"));
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  const store=new MemoryStore(memoryDb);
  try {
    memoryDb.db.prepare("INSERT INTO repositories(name,path) VALUES('fixture','/fixture')").run();
    assert.throws(()=>store.addRepositoryDecision("fixture",{key:"adr.bad",title:"Bad",rationale:"too short",status:"accepted",sourceKind:"human",sourceRef:"meeting",approvedBy:"",approvedAt:"2026-08-31"}),/rationale|approvedBy/);
    store.addRepositoryDecision("fixture",{key:"adr.cache.v1",title:"Cache v1",rationale:"Use revalidation to reduce upstream load.",status:"accepted",sourceKind:"adr",sourceRef:"docs/adr/001-cache.md",sourceSha:SHA_A,approvedBy:"architecture-board",approvedAt:"2026-08-30T10:00:00Z"});
    store.addRepositoryDecision("fixture",{key:"adr.cache.v2",title:"Cache v2",rationale:"Use no-store because responses are customer specific.",status:"accepted",sourceKind:"pr",sourceRef:"PR-42",sourceSha:SHA_B,approvedBy:"architecture-board",approvedAt:"2026-08-31T10:00:00Z",supersedesKey:"adr.cache.v1"});
    const rows=store.listRepositoryDecisions("fixture");
    assert.equal(rows.find((item)=>item.decisionKey==="adr.cache.v1")?.status,"superseded");
    const context=buildDecisionContext(store,"fixture","Why do we use no-store cache?");
    assert.equal(context.kind,"decision");
    assert.deepEqual(context.decisions.map((item:any)=>item.decisionKey),["adr.cache.v2"]);
    assert.equal(context.answerContract.uncertainty.level,"none");
    assert.equal(isDecisionQuestion("Contact form neden 400 Captcha failed döndürebilir?"),false);
    const compiled=await new TaskContextCompiler(memoryDb).compile("Why do we use no-store cache?",{repository:"fixture"});
    assert.equal(compiled.kind,"decision");
  } finally { memoryDb.close(); await rm(root,{recursive:true,force:true}); }
});

test("keeps native, instruction and source-truth memory ownership disjoint",async()=>{
  const policy=JSON.parse(await readFile(path.resolve("config/memory-ownership.json"),"utf8"));
  const matrix=ownershipMatrix();
  const seen=new Set<string>();
  for (const [owner,value] of Object.entries(policy.owners) as Array<[string,any]>) {
    for (const kind of value.owns) {
      assert.equal(matrix[kind as keyof typeof matrix],owner);
      assert.equal(seen.has(kind),false,`${kind} has more than one owner`);
      seen.add(kind);
    }
  }
  assert.equal(seen.size,Object.keys(matrix).length);
});
