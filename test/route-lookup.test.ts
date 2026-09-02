import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { TaskContextCompiler } from "../src/retrieval/task-context.js";
import { MemoryTools } from "../src/mcp/tools.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

const SHA="a".repeat(40);

/**
 * Two pages whose only distinguishing feature is their name. Every ranking
 * feature except query relevance is identical for them, which is exactly the
 * shape that used to resolve a route lookup to the alphabetically first route.
 */
async function fixture():Promise<{root:string;memoryDb:MemoryDatabase}> {
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-route-lookup-"));
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  await mkdir(path.join(root,"src/app/kart-sihirbazi"),{recursive:true});
  await writeFile(path.join(root,"package.json"),JSON.stringify({scripts:{build:"next build"}},null,2));
  await writeFile(path.join(root,"src/app/page.tsx"),"export default function Page(){ return null }\n");
  await writeFile(path.join(root,"src/app/kart-sihirbazi/page.tsx"),"export default function Page(){ return null }\n");
  memoryDb.db.prepare(
    "INSERT INTO repositories(name,path,framework,next_version,router_type,query_aliases_json,last_indexed_sha) VALUES(?,?,?,?,?,?,?)",
  ).run("fixture",root,"Next.js","16.3.0","app",
    JSON.stringify({"kart sihirbazi":["kart sihirbazı","kart-sihirbazi"],"ana sayfa":["homepage"]}),SHA);
  const insertRoute=memoryDb.db.prepare(
    "INSERT INTO routes(repository_id,route,route_type,router_type,source_file,rendering_mode,server_component,control_flow_json,evidence_json,last_seen_sha,active)"
    +" VALUES(1,?,'page','app',?,'dynamic-ssr',1,?,?,?,1)",
  );
  insertRoute.run("/","src/app/page.tsx",JSON.stringify([]),JSON.stringify([]),SHA);
  insertRoute.run("/kart-sihirbazi","src/app/kart-sihirbazi/page.tsx",
    JSON.stringify([{kind:"redirect",target:"/kart-sihirbazi/form",conditional:true}]),
    JSON.stringify(["src/app/kart-sihirbazi/page.tsx:51: redirect -> /kart-sihirbazi/form (conditional)"]),SHA);
  insertRoute.run("/kart-sihirbazi/form","src/app/kart-sihirbazi/form/page.tsx",JSON.stringify([]),JSON.stringify([]),SHA);
  return {root,memoryDb};
}

test("a product-name route lookup is answered from the routes table, not from lexical search",async()=>{
  const {root,memoryDb}=await fixture();
  try {
    const pack=await new TaskContextCompiler(memoryDb).compile(
      "Kart sihirbazı ana sayfası hangi route ve source dosyasındadır?",{repository:"fixture"}) as any;

    assert.equal(pack.kind,"lookup");
    assert.equal(pack.route.route,"/kart-sihirbazi");
    assert.equal(pack.route.sourceFile,"src/app/kart-sihirbazi/page.tsx");
    assert.equal(pack.route.claimKind,"fact");
    assert.equal(pack.retrieval.resolvedBy,"registry-vocabulary");
    // Round two exists to recover from a round-one miss; a resolved anchor is not a miss.
    assert.deepEqual(pack.retrieval.rounds,["exact-sql"]);
    assert.equal(pack.retrieval.secondRound.run,false);
  } finally { memoryDb.close(); await rm(root,{recursive:true,force:true}); }
});

test("a resolved route answer is reported as sufficient, with no source fallback",async()=>{
  const {root,memoryDb}=await fixture();
  try {
    const pack=await new TaskContextCompiler(memoryDb).compile(
      "Kart sihirbazı sayfası hangi dosyadadır?",{repository:"fixture"}) as any;
    assert.equal(pack.answerContract.uncertainty.level,"none");
    assert.deepEqual(pack.answerContract.sourceFallback,[]);
    assert.ok(pack.answerContract.facts.includes("route.sourceFile"));
    assert.ok(pack.budget.usedChars<=pack.budget.maxChars);
    assert.equal(pack.budget.estimatedTokens,Math.ceil(pack.budget.usedChars/3.5));
  } finally { memoryDb.close(); await rm(root,{recursive:true,force:true}); }
});

test("an explicit route path resolves without vocabulary, and optional sections stay off",async()=>{
  const {root,memoryDb}=await fixture();
  try {
    const pack=await new TaskContextCompiler(memoryDb).compile(
      "/kart-sihirbazi hangi dosyadan gelir?",{repository:"fixture"}) as any;
    assert.equal(pack.route.route,"/kart-sihirbazi");
    assert.equal(pack.retrieval.resolvedBy,"route-anchor");
    assert.equal(pack.relatedRoutes,undefined,"siblings are attached only when the question asks for them");
    assert.equal(pack.route.renderingEvidence,undefined,"rendering provenance is not free");
  } finally { memoryDb.close(); await rm(root,{recursive:true,force:true}); }
});

test("rendering and sibling questions attach the sections they ask for",async()=>{
  const {root,memoryDb}=await fixture();
  try {
    const compiler=new TaskContextCompiler(memoryDb);
    const rendering=await compiler.compile("/kart-sihirbazi nasıl render ediliyor?",{repository:"fixture"}) as any;
    assert.ok((rendering.route.renderingEvidence ?? []).length>0);
    const siblings=await compiler.compile("/kart-sihirbazi altındaki route'lar hangi dosyalarda?",{repository:"fixture"}) as any;
    assert.deepEqual((siblings.relatedRoutes ?? []).map((item:any)=>item.route),["/kart-sihirbazi/form"]);
  } finally { memoryDb.close(); await rm(root,{recursive:true,force:true}); }
});

test("an unresolvable lookup falls through to semantic retrieval and says round two ran",async()=>{
  const {root,memoryDb}=await fixture();
  try {
    const pack=await new TaskContextCompiler(memoryDb).compile(
      "Ödeme kuyruğu sayfası hangi dosyadadır?",{repository:"fixture"}) as any;
    assert.equal(pack.route,undefined);
    assert.deepEqual(pack.retrieval.rounds,["exact-sql","fts","vector"]);
    assert.equal(pack.retrieval.secondRound.run,true);
  } finally { memoryDb.close(); await rm(root,{recursive:true,force:true}); }
});

test("a generic vocabulary fragment never resolves a route on its own",async()=>{
  const {root,memoryDb}=await fixture();
  try {
    // "form" is a derived fragment shared by many groups; acting on it would
    // answer a question the user did not ask.
    const pack=await new TaskContextCompiler(memoryDb).compile(
      "Form gönderimi hangi dosyada?",{repository:"fixture"}) as any;
    assert.equal(pack.route,undefined);
  } finally { memoryDb.close(); await rm(root,{recursive:true,force:true}); }
});

test("telemetry counts a structured route answer as a result, not an abstention",async()=>{
  const {root,memoryDb}=await fixture();
  try {
    const tools=new MemoryTools(memoryDb);
    const pack=await tools.context("Kart sihirbazı ana sayfası hangi route ve source dosyasındadır?",
      {repository:"fixture"}) as any;
    const event=memoryDb.db.prepare("SELECT result_count,fallback FROM retrieval_events WHERE id=?")
      .get(pack.telemetryEventId) as {result_count:number;fallback:string|null};
    assert.ok(event.result_count>0);
    assert.notEqual(event.fallback,"abstain");
  } finally { memoryDb.close(); await rm(root,{recursive:true,force:true}); }
});
