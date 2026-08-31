import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { evaluateSecondPilotGate } from "../src/rollout/pilot-gate.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

/** A run that clears every retrieval threshold. */
function passingEvalRun():unknown {
  const clean=(id:string,strict:boolean)=>({caseId:id,strict,diagnosis:{primaryMissClass:null}});
  return {totals:{meanEvidenceRecall:0.95},cases:[
    clean("A",true),clean("B",true),clean("C",false),clean("D",false),clean("E",false),
  ]};
}

function passingEconomyRun():unknown {
  return {variableCost:{cases:5,effective:{median:1200},nominal:{negativeCases:[]}}};
}

async function fixture():Promise<{root:string;memoryDb:MemoryDatabase;cleanup:()=>Promise<void>}> {
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-gate-"));
  const repo=path.join(root,"pilot");
  await mkdir(repo,{recursive:true});
  const registry=path.join(root,"repositories.json");
  await writeFile(registry,JSON.stringify({repositories:[{name:"pilot",path:repo,mainBranch:"main"}]}));
  const previous=process.env.MEMORY_REPOSITORIES_FILE;
  process.env.MEMORY_REPOSITORIES_FILE=registry;

  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  memoryDb.db.prepare("INSERT INTO repositories(name,path,router_type,last_indexed_sha) VALUES(?,?,?,?)")
    .run("pilot",repo,"app","a".repeat(40));
  return {root,memoryDb,cleanup:async()=>{
    memoryDb.close();
    if (previous===undefined) delete process.env.MEMORY_REPOSITORIES_FILE; else process.env.MEMORY_REPOSITORIES_FILE=previous;
    await rm(root,{recursive:true,force:true});
  }};
}

async function runFiles(root:string,evalRun:unknown,economyRun:unknown):Promise<{evalRun:string;economyRun:string}> {
  const evalFile=path.join(root,"eval.json");
  const economyFile=path.join(root,"economy.json");
  await writeFile(evalFile,JSON.stringify(evalRun));
  await writeFile(economyFile,JSON.stringify(economyRun));
  return {evalRun:evalFile,economyRun:economyFile};
}

test("opens only when every measured threshold is met",async()=>{
  const {root,memoryDb,cleanup}=await fixture();
  try {
    const files=await runFiles(root,passingEvalRun(),passingEconomyRun());
    const report=await evaluateSecondPilotGate(memoryDb,files);
    assert.deepEqual(report.blockers,[],"a gate that cannot open is indistinguishable from a gate that never checks");
    assert.equal(report.decision,"open");
    assert.equal(report.checks.find((item)=>item.id==="retrieval.recall")?.status,"pass");
    assert.equal(report.checks.find((item)=>item.id==="economy.effectiveSaving")?.status,"pass");
    assert.equal(report.checks.find((item)=>item.id==="semantics.blockingGaps")?.status,"pass");
  } finally { await cleanup(); }
});

test("blocks on a low recall run and names the number it needed",async()=>{
  const {root,memoryDb,cleanup}=await fixture();
  try {
    const weak:any=passingEvalRun();
    weak.totals.meanEvidenceRecall=0.54;
    const report=await evaluateSecondPilotGate(memoryDb,await runFiles(root,weak,passingEconomyRun()));
    assert.equal(report.decision,"blocked");
    assert.ok(report.blockers.some((item)=>item.includes("retrieval.recall")&&item.includes("0.9")));
  } finally { await cleanup(); }
});

test("blocks when the engine costs more than reading the source",async()=>{
  const {root,memoryDb,cleanup}=await fixture();
  try {
    const economy:any=passingEconomyRun();
    economy.variableCost.effective.median=-883;
    economy.variableCost.nominal.negativeCases=["A","B","C"];
    const report=await evaluateSecondPilotGate(memoryDb,await runFiles(root,passingEvalRun(),economy));
    assert.ok(report.blockers.some((item)=>item.includes("economy.effectiveSaving")));
    assert.ok(report.blockers.some((item)=>item.includes("economy.engineLoses")));
  } finally { await cleanup(); }
});

test("a strict case that missed blocks the gate on its own",async()=>{
  const {root,memoryDb,cleanup}=await fixture();
  try {
    const run:any=passingEvalRun();
    run.cases[0].diagnosis.primaryMissClass="unsupported-inference";
    const report=await evaluateSecondPilotGate(memoryDb,await runFiles(root,run,passingEconomyRun()));
    assert.ok(report.blockers.some((item)=>item.includes("retrieval.strict")));
  } finally { await cleanup(); }
});

test("reports insufficient evidence rather than opening when a run is missing",async()=>{
  const {root,memoryDb,cleanup}=await fixture();
  try {
    const report=await evaluateSecondPilotGate(memoryDb,{
      evalRun:path.join(root,"absent-eval.json"),
      economyRun:path.join(root,"absent-economy.json"),
    });
    assert.ok(report.checks.some((item)=>item.status==="unknown"),"a missing run is unknown, never a pass");
    assert.notEqual(report.decision,"open");
  } finally { await cleanup(); }
});

test("rejects a candidate that is not in the registry",async()=>{
  const {root,memoryDb,cleanup}=await fixture();
  try {
    const files=await runFiles(root,passingEvalRun(),passingEconomyRun());
    const report=await evaluateSecondPilotGate(memoryDb,{...files,candidate:"ghost"});
    assert.ok(report.blockers.some((item)=>item.includes("candidate.registered")));
  } finally { await cleanup(); }
});

test("states the diversity requirement it cannot yet confirm for a registered candidate",async()=>{
  const {root,memoryDb,cleanup}=await fixture();
  try {
    const files=await runFiles(root,passingEvalRun(),passingEconomyRun());
    const report=await evaluateSecondPilotGate(memoryDb,{...files,candidate:"pilot"});
    const diversity=report.checks.find((item)=>item.id==="candidate.diversity");
    assert.equal(diversity?.status,"unknown");
    assert.match(diversity!.threshold,/router or architecture/);
  } finally { await cleanup(); }
});
