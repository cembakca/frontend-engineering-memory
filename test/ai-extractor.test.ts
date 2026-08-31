import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { validateAiExtraction, type AiExtractionProvider, type AiExtractionRequest } from "../src/extractors/ai.js";
import { MemoryDatabase } from "../src/memory/database.js";
import { fullIndex } from "../src/sync/sync.js";
import { runAiExtraction } from "../src/sync/ai-extract.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();
const exec=promisify(execFile);

const request:AiExtractionRequest={
  repository:"fixture",sourceFile:"src/app/offers/page.tsx",allowedTypes:["business_capability","business_rule"],
  source:"export function Offers(){\n  const publicOnly = !session;\n  return publicOnly;\n}",
};

test("accepts only confidence-gated AI memories with exact source evidence",()=>{
  const valid=validateAiExtraction(request,{memories:[{
    type:"business_rule",subject:"public offers",content:"The code distinguishes public-only offers when there is no session.",confidence:0.91,
    evidence:{filePath:request.sourceFile,startLine:2,endLine:2,quote:"const publicOnly = !session;",symbol:"Offers"},
  }]});
  assert.equal(valid.memories.length,1);
  assert.equal(valid.memories[0]?.producer,"ai");
  assert.equal(valid.memories[0]?.confidence,"inferred");
  assert.equal(valid.memories[0]?.qualityScore,0.91);
  assert.deepEqual(valid.rejections,[]);

  const rejected=validateAiExtraction(request,{memories:[
    {type:"business_rule",subject:"invented",content:"Invented claim",confidence:0.99,evidence:{filePath:request.sourceFile,startLine:2,endLine:2,quote:"not in source"}},
    {type:"business_capability",subject:"weak",content:"Weak claim",confidence:0.4,evidence:{filePath:request.sourceFile,startLine:1,endLine:1,quote:"export function Offers(){"}},
  ]});
  assert.equal(rejected.memories.length,0);
  assert.equal(rejected.rejections.length,2);
});

test("stores explicit AI extraction and preserves it only while evidence hash is current",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const repo=await mkdtemp(path.join(os.tmpdir(),"fem-ai-repo-"));
  const dbRoot=await mkdtemp(path.join(os.tmpdir(),"fem-ai-db-"));
  const sourceFile="src/app/page.tsx";
  const source=async(content:string)=>{ const target=path.join(repo,sourceFile); await mkdir(path.dirname(target),{recursive:true}); await writeFile(target,content); };
  const git=async(...args:string[])=>exec("git",["-C",repo,...args]);
  await git("init","-b","main"); await git("config","user.email","test@example.com"); await git("config","user.name","Test");
  await writeFile(path.join(repo,"package.json"),JSON.stringify({dependencies:{next:"16.0.0",react:"19.0.0"}}));
  await source("export function Offers(){ return 'public offers' }\n");
  await git("add","."); await git("commit","-m","initial");
  const config={name:"fixture",path:repo,mainBranch:"main"};
  const memoryDb=new MemoryDatabase(path.join(dbRoot,"memory.sqlite"));
  const provider:AiExtractionProvider={extract:async()=>({memories:[{
    type:"business_capability",subject:"public offers",content:"The route exposes public offers.",confidence:0.93,
    evidence:{filePath:sourceFile,startLine:1,endLine:1,quote:"return 'public offers'",symbol:"Offers"},
  }]})};
  try {
    await fullIndex(config,memoryDb);
    const extracted=await runAiExtraction(config,memoryDb,{sourceFiles:[sourceFile],provider});
    assert.equal(extracted.memoriesCreated,1);
    assert.equal((memoryDb.db.prepare("SELECT count(*) count FROM memories WHERE active=1 AND producer='ai'").get() as {count:number}).count,1);
    const reconciled=await fullIndex(config,memoryDb) as {aiMemoriesPreserved:number};
    assert.equal(reconciled.aiMemoriesPreserved,1);

    await source("export function Offers(){ return 'all offers' }\n");
    await git("add","."); await git("commit","-m","change evidence");
    await fullIndex(config,memoryDb);
    assert.equal((memoryDb.db.prepare("SELECT count(*) count FROM memories WHERE active=1 AND producer='ai'").get() as {count:number}).count,0);
  } finally {
    memoryDb.close(); await rm(repo,{recursive:true,force:true}); await rm(dbRoot,{recursive:true,force:true});
  }
});
