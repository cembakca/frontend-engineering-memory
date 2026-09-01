import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { inferArchitectureFamily } from "../src/onboarding/onboard.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

test("infers architecture family from strong package signals without treating generic auth-like names as product state",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-onboarding-"));
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  try {
    memoryDb.db.prepare("INSERT INTO repositories(name,path) VALUES('content',?),('product',?)").run(root,root);
    const insert=memoryDb.db.prepare(`INSERT INTO repository_package_dependencies(repository_id,package_name,dependency_kind)
      VALUES(?,?, 'runtime')`);
    insert.run(1,"class-variance-authority");
    insert.run(2,"@tanstack/react-query");
    assert.equal(inferArchitectureFamily(memoryDb,"content").family,"content-site");
    assert.equal(inferArchitectureFamily(memoryDb,"product").family,"product-app");
  } finally {
    memoryDb.close();
    await rm(root,{recursive:true,force:true});
  }
});
