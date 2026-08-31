import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { MemoryStore } from "../src/memory/store.js";
import { MemoryTools } from "../src/mcp/tools.js";
import { TaskContextCompiler } from "../src/retrieval/task-context.js";
import type { RepositoryProfile } from "../src/types.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

function profile(name:string,packageName:string,dependencies:RepositoryProfile["packageDependencies"]):RepositoryProfile {
  return {name,path:`/repos/${name}`,framework:"Next.js",nextVersion:"16.0.0",reactVersion:"19.0.0",nodeVersion:">=20",
    routerType:"app",packageManager:"pnpm",buildCommand:"pnpm run build",startCommand:"pnpm run start",devCommand:"pnpm run dev",
    outputMode:"standalone",packageName,packageDependencies:dependencies,evidenceFiles:["package.json"]};
}

test("builds directional cross-repository links from package identities",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-repository-links-"));
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  try {
    const store=new MemoryStore(memoryDb);
    const design=profile("design-system","@company/design-system",[]);
    const shop=profile("shop","@company/shop",[{name:"@company/design-system",kind:"runtime"}]);
    const designId=store.upsertRepository({name:"design-system",path:design.path},design);
    store.replaceRepositoryPackageDependencies(designId,design.packageDependencies,"a".repeat(40));
    const shopId=store.upsertRepository({name:"shop",path:shop.path},shop);
    store.replaceRepositoryPackageDependencies(shopId,shop.packageDependencies,"b".repeat(40));

    assert.deepEqual(store.listRepositoryLinks("shop").map((link)=>({consumer:link.consumer_repository,provider:link.provider_repository,direction:link.direction})),[
      {consumer:"shop",provider:"design-system",direction:"outgoing"},
    ]);
    const provider=new MemoryTools(memoryDb).repository("design-system");
    assert.equal(provider.repositoryConsumers[0].consumer_repository,"shop");
    assert.equal(provider.repositoryConsumers[0].direction,"incoming");
    const context=await new TaskContextCompiler(memoryDb).compile("Bu repo hangi repository'ye bağımlı?",{repository:"shop"});
    assert.equal(context.kind,"repository-dependencies");
    assert.equal(context.relations[0].providerRepository,"design-system");
    assert.equal(context.answerContract.uncertainty.level,"none");
  } finally {
    memoryDb.close();
    await rm(root,{recursive:true,force:true});
  }
});
