import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeSourceFile, listAnalyzableSourceFiles } from "../src/analyzers/source-memory.js";
import { classifyFile } from "../src/sync/classifier.js";

async function file(root:string,relative:string,content:string):Promise<void> {
  const target=path.join(root,relative);
  await mkdir(path.dirname(target),{recursive:true});
  await writeFile(target,content);
}

test("classifies route, middleware, build, config and irrelevant changes",()=>{
  assert.ok(classifyFile("src/app/account/page.tsx").analyzers.includes("route"));
  assert.deepEqual(classifyFile("src/middleware.ts").analyzers,["middleware","authentication","route","security"]);
  assert.deepEqual(classifyFile("Dockerfile").analyzers,["build","configuration"]);
  assert.deepEqual(classifyFile(".env.production").analyzers,["configuration","security"]);
  assert.equal(classifyFile("README.md").memoryRelevant,false);
});

test("produces missing P1 memory types with symbol and source ranges",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-analyzers-"));
  try {
    const sourceFile="src/app/page.tsx";
    await file(root,sourceFile,`import { useMemo } from "react";
import { create } from "zustand";
import DOMPurify from "dompurify";
// BUSINESS_RULE: anonymous users may only see public offers
export function Offers(){
  const visible=useMemo(()=>[],[]);
  return DOMPurify.sanitize(String(visible));
}`);
    const memories=await analyzeSourceFile(root,sourceFile);
    for (const type of ["state_management","security","performance_observation","business_rule"] as const) {
      assert.ok(memories.some((memory)=>memory.type===type),`missing ${type}`);
    }
    // RCE-006 R1: a capability derived from the path states nothing the routes table
    // does not already hold, so it is rejected at extraction.
    assert.equal(memories.some((memory)=>memory.type==="business_capability"),false,
      "a path-derivable capability must not be emitted");
    assert.equal(memories.some((memory)=>memory.type==="design_system"),false,
      "an internal-package import restates the dependencies row");
    const rule=memories.find((memory)=>memory.type==="business_rule");
    assert.ok(rule?.startLine);
    assert.ok(rule?.endLine);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("excludes a custom Next.js distDir from source analysis",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-distdir-"));
  try {
    await file(root,"next.config.ts",`export default { distDir: "aboutus" }`);
    await file(root,"src/app/page.tsx","export default function Page(){ return null }");
    await file(root,"aboutus/server/app/page.js","compiled output");
    const files=await listAnalyzableSourceFiles(root);
    assert.ok(files.includes("src/app/page.tsx"));
    assert.ok(!files.includes("aboutus/server/app/page.js"));
  } finally { await rm(root,{recursive:true,force:true}); }
});
