import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { scaffoldEvaluationOverlay, validateEvaluationFleet } from "../src/retrieval/evaluation-fleet.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

test("the checked-in fleet assigns both registered architecture representatives",async()=>{
  const file=fileURLToPath(new URL("../config/evaluation-fleet.json",import.meta.url));
  const result=await validateEvaluationFleet(file,{registryRepositories:["hangikredi.aboutus.fe.next","hangikredi.revolt.fe.next"]});
  assert.equal(result.validation.ok,true,result.validation.errors.join("\n"));
  assert.deepEqual(result.validation.suites.map((item)=>[item.role,item.cases]),
    [["representative",15],["representative",13]]);
  assert.ok(result.validation.suites.every((item)=>["lookup","flow","impact","implementation","debug","verify","negative"]
    .every((job)=>item.jobs.includes(job))));
});

test("fleet validation rejects shallow drafts and uncovered repositories",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-eval-fleet-"));
  try {
    await writeFile(path.join(root,"suite.json"),JSON.stringify({suite:"draft",repository:"one",targetSha:"a".repeat(40),draft:true,cases:[]}));
    await writeFile(path.join(root,"fleet.json"),JSON.stringify({
      version:1,
      policy:{representativeCases:{min:10,max:15},overlayCases:{min:5,max:7},
        requiredRepresentativeJobs:["lookup","flow"],requiredOverlayJobs:["lookup"],
        thresholds:{meanEvidenceRecall:.9,medianContextSavingPercent:40,primaryMisses:0,strictMisses:0}},
      families:[{id:"family",description:"fixture",representativeRepository:"one"}],
      repositories:[{repository:"one",family:"family",role:"representative",suite:"suite.json"}],
    }));
    const result=await validateEvaluationFleet(path.join(root,"fleet.json"),{registryRepositories:["one","two"]});
    assert.equal(result.validation.ok,false);
    assert.ok(result.validation.errors.some((item)=>item.includes("draft suite")));
    assert.ok(result.validation.errors.some((item)=>item.includes("expected 10-15")));
    assert.ok(result.validation.errors.some((item)=>item.includes("two: registered repository has no evaluation assignment")));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("scaffolds a bounded overlay with every mandatory job and explicit human-review blockers",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-eval-scaffold-"));
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  try {
    memoryDb.db.prepare("INSERT INTO repositories(name,path,last_indexed_sha) VALUES(?,?,?)")
      .run("fixture",root,"a".repeat(40));
    memoryDb.db.prepare(`INSERT INTO routes(repository_id,route,route_type,router_type,source_file,rendering_mode,
      data_sources_json,backend_dependencies_json,behavior_files_json,last_seen_sha)
      VALUES(1,'/products','page','app','src/app/products/page.tsx','rsc','["getProducts"]','["GET /products"]','["src/lib/products.ts"]',?)`)
      .run("a".repeat(40));
    const draft=scaffoldEvaluationOverlay(memoryDb,"fixture","product-app");
    assert.equal(draft.draft,true);
    assert.equal(draft.cases.length,6);
    assert.deepEqual(draft.cases.map((item:any)=>item.job),["lookup","flow","impact","implementation","verify","negative"]);
    assert.ok(draft.cases.some((item:any)=>String(item.strictFact).includes("TODO")));
    assert.equal(draft.reviewRequired.length,3);
  } finally {
    memoryDb.close();
    await rm(root,{recursive:true,force:true});
  }
});
