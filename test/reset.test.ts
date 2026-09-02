import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { planReset, resetMemory } from "../src/memory/reset.js";
import { dbPath } from "../src/config.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

const SHA="c".repeat(40);

async function seeded():Promise<{root:string;file:string;memoryDb:MemoryDatabase}> {
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-reset-"));
  const file=path.join(root,"memory.sqlite");
  const memoryDb=new MemoryDatabase(file);
  memoryDb.db.prepare(
    "INSERT INTO repositories(name,path,framework,next_version,router_type,last_indexed_sha) VALUES(?,?,?,?,?,?)",
  ).run("fixture",root,"Next.js","16.3.0","app",SHA);
  memoryDb.db.prepare(
    "INSERT INTO routes(repository_id,route,route_type,router_type,source_file,rendering_mode,last_seen_sha,active)"
    +" VALUES(1,'/','page','app','src/app/page.tsx','rsc',?,1)").run(SHA);
  memoryDb.db.prepare(
    "INSERT INTO memories(repository_id,memory_type,subject,content,confidence,source_hash,created_sha,updated_sha,active)"
    +" VALUES(1,'rendering','route:/','Route / renders as rsc.','verified','hash',?,?,1)").run(SHA,SHA);
  memoryDb.db.prepare(
    "INSERT INTO retrieval_events(repository_id,tool,query_hash,query_shape_json,result_count)"
    +" VALUES(1,'memory_context','hash','{}',3)").run();
  return {root,file,memoryDb};
}

test("a reset reports what it would destroy and destroys nothing without confirmation",async()=>{
  const {root,memoryDb}=await seeded();
  try {
    const plan=planReset(memoryDb);
    assert.deepEqual(plan.repositories,["fixture"]);
    assert.equal(plan.counts.memories,1);
    assert.equal(plan.counts.retrieval_events,1);
    assert.ok(plan.totalRows>=4);

    const refused=await resetMemory(memoryDb,{confirm:false});
    assert.equal(refused.performed,false);
    assert.equal(refused.remaining.memories,1);
    assert.equal(memoryDb.db.prepare("SELECT COUNT(*) n FROM repositories").get<{n:number}>().n,1);
  } finally { memoryDb.close(); await rm(root,{recursive:true,force:true}); }
});

test("a confirmed reset empties every indexed table and keeps the schema usable",async()=>{
  const {root,file,memoryDb}=await seeded();
  try {
    const result=await resetMemory(memoryDb,{confirm:true});
    assert.equal(result.performed,true);
    assert.deepEqual(result.removedFiles,[]);
    assert.ok(Object.values(result.remaining).every((count)=>count===0),JSON.stringify(result.remaining));
    await access(file);
    // The emptied database still accepts writes: the schema survived.
    memoryDb.db.prepare("INSERT INTO repositories(name,path,framework,router_type) VALUES('again',?,'Next.js','app')").run(root);
    assert.equal(memoryDb.db.prepare("SELECT COUNT(*) n FROM repositories").get<{n:number}>().n,1);
  } finally { memoryDb.close(); await rm(root,{recursive:true,force:true}); }
});

test("scope limits the reset to indexed knowledge or to observed usage",async()=>{
  const {root,memoryDb}=await seeded();
  try {
    await resetMemory(memoryDb,{scope:"telemetry",confirm:true});
    assert.equal(memoryDb.db.prepare("SELECT COUNT(*) n FROM retrieval_events").get<{n:number}>().n,0);
    assert.equal(memoryDb.db.prepare("SELECT COUNT(*) n FROM memories").get<{n:number}>().n,1,
      "indexed knowledge is untouched by a telemetry reset");

    await resetMemory(memoryDb,{scope:"index",confirm:true});
    assert.equal(memoryDb.db.prepare("SELECT COUNT(*) n FROM memories").get<{n:number}>().n,0);
    assert.equal(memoryDb.db.prepare("SELECT COUNT(*) n FROM routes").get<{n:number}>().n,0);
  } finally { memoryDb.close(); await rm(root,{recursive:true,force:true}); }
});

test("a reset targets the database it was handed, not the configured default",async()=>{
  const {root,file,memoryDb}=await seeded();
  try {
    // Regression: resolving the path from configuration instead of from the
    // open connection deletes whichever database the environment points at.
    assert.equal(planReset(memoryDb).file,file);
    assert.notEqual(planReset(memoryDb).file,dbPath());
  } finally { memoryDb.close(); await rm(root,{recursive:true,force:true}); }
});

test("a hard reset removes the database file and its journals",async()=>{
  const {root,file,memoryDb}=await seeded();
  try {
    const result=await resetMemory(memoryDb,{hard:true,confirm:true});
    assert.equal(result.file,file);
    assert.equal(result.performed,true);
    assert.ok(result.removedFiles.includes(file));
    await assert.rejects(access(file),"the database file is gone");
    // The next run recreates the schema from scratch.
    const rebuilt=new MemoryDatabase(file);
    assert.equal(rebuilt.db.prepare("SELECT COUNT(*) n FROM repositories").get<{n:number}>().n,0);
    rebuilt.close();
  } finally { await rm(root,{recursive:true,force:true}); }
});
