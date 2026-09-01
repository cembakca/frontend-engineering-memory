import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { TaskContextCompiler } from "../src/retrieval/task-context.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

test("repository test-strategy questions include package scripts and explicit test gaps",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-verification-context-"));
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  try {
    await writeFile(path.join(root,"package.json"),JSON.stringify({
      scripts:{lint:"eslint .",build:"next build"},
    },null,2));
    memoryDb.db.prepare(
      "INSERT INTO repositories(name,path,framework,next_version,router_type,last_indexed_sha) VALUES(?,?,?,?,?,?)",
    ).run("fixture",root,"Next.js","16.3.0","app","a".repeat(40));

    const pack=await new TaskContextCompiler(memoryDb).compile(
      "Projenin error-handling ve automated-test stratejisi nedir?",
      {repository:"fixture"},
    ) as any;

    assert.equal(pack.kind,"implementation");
    assert.deepEqual(pack.verification.commands.map((item:any)=>item.name),["lint","build"]);
    assert.ok(pack.verification.commands.every((item:any)=>item.evidence.file==="package.json"));
    assert.ok(pack.verification.gaps.some((item:any)=>item.kind==="missing-test-command"));
    assert.ok(pack.verification.gaps.some((item:any)=>item.kind==="missing-test-files"));
  } finally {
    memoryDb.close();
    await rm(root,{recursive:true,force:true});
  }
});

test("a repository product alias anchors flow traversal at the matching route source",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-alias-context-"));
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  try {
    await mkdir(path.join(root,"src/app/products"),{recursive:true});
    await mkdir(path.join(root,"src/lib"),{recursive:true});
    await writeFile(path.join(root,"package.json"),JSON.stringify({scripts:{build:"next build"}},null,2));
    await writeFile(path.join(root,"src/app/products/page.tsx"),
      'import { getProducts } from "../../lib/products";\nexport default async function Page(){ return getProducts(); }\n');
    await writeFile(path.join(root,"src/lib/products.ts"),
      'export function getProducts(){ return "products"; }\n');
    memoryDb.db.prepare(
      "INSERT INTO repositories(name,path,framework,next_version,router_type,query_aliases_json,last_indexed_sha) VALUES(?,?,?,?,?,?,?)",
    ).run("fixture",root,"Next.js","16.3.0","app",JSON.stringify({"ürünler":["products"]}),"a".repeat(40));
    memoryDb.db.prepare(
      "INSERT INTO routes(repository_id,route,route_type,router_type,source_file,rendering_mode,last_seen_sha) VALUES(1,'/products','page','app','src/app/products/page.tsx','rsc',?)",
    ).run("a".repeat(40));

    const pack=await new TaskContextCompiler(memoryDb).compile(
      "Ürünler sayfası veriyi hangi akışla alır?",
      {repository:"fixture"},
    ) as any;

    assert.equal(pack.kind,"flow");
    assert.match(pack.seed,/src\/app\/products\/page\.tsx#Page/);
    assert.ok(pack.steps.some((item:any)=>item.to==="src/lib/products.ts#getProducts"));
  } finally {
    memoryDb.close();
    await rm(root,{recursive:true,force:true});
  }
});
