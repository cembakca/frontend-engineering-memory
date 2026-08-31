import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { startServer } from "../src/server.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

test("HTTP sync requires a full expected commit SHA",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  process.env.MEMORY_HOST="127.0.0.1";
  process.env.MEMORY_PORT="0";
  const dbRoot=await mkdtemp(path.join(os.tmpdir(),"fem-server-db-"));
  const memoryDb=new MemoryDatabase(path.join(dbRoot,"memory.sqlite"));
  const server=startServer(memoryDb);
  try {
    if (!server.listening) await once(server,"listening");
    const address=server.address();
    assert.ok(address && typeof address === "object");
    const response=await fetch(`http://127.0.0.1:${address.port}/sync`,{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({repository:"fixture"}),
    });
    assert.equal(response.status,400);
    assert.deepEqual(await response.json(),{error:"commit must be a full 40-character Git SHA"});
  } finally {
    await new Promise<void>((resolve,reject)=>server.close((error)=>error ? reject(error) : resolve()));
    memoryDb.close();
    await rm(dbRoot,{recursive:true,force:true});
  }
});
