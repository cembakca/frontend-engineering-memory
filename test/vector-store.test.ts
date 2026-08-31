import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

test("filters vector KNN inside sqlite-vec by repository and memory type",async()=>{
  const previous=process.env.MEMORY_EMBEDDINGS_ENABLED;
  process.env.MEMORY_EMBEDDINGS_ENABLED="1";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-vector-db-"));
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  try {
    assert.ok(memoryDb.vectorStore);
    memoryDb.db.prepare("INSERT INTO repositories(name,path) VALUES(?,?)").run("one","/one");
    memoryDb.db.prepare("INSERT INTO repositories(name,path) VALUES(?,?)").run("two","/two");
    const insert=memoryDb.db.prepare("INSERT INTO memories(repository_id,memory_type,subject,content,confidence) VALUES(?,?,?,?,?)");
    insert.run(1,"cache","one-cache","x","verified");
    insert.run(1,"security","one-security","x","verified");
    insert.run(2,"cache","two-cache","x","verified");
    const vector=new Float32Array(memoryDb.vectorDimension); vector[0]=1;
    memoryDb.vectorStore!.set(1,vector,{repositoryId:1,memoryType:"cache"});
    memoryDb.vectorStore!.set(2,vector,{repositoryId:1,memoryType:"security"});
    memoryDb.vectorStore!.set(3,vector,{repositoryId:2,memoryType:"cache"});
    assert.deepEqual(memoryDb.vectorStore!.search(vector,{repositoryId:1,memoryTypes:["cache"],limit:10}),[{id:1,distance:0}]);
  } finally {
    memoryDb.close();
    if (previous==null) delete process.env.MEMORY_EMBEDDINGS_ENABLED; else process.env.MEMORY_EMBEDDINGS_ENABLED=previous;
    await rm(root,{recursive:true,force:true});
  }
});
