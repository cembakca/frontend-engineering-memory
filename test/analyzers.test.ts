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

test("extracts nullable module contracts, registries and guarded HTTP errors",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-contracts-"));
  try {
    await file(root,"src/lib/captcha/captcha-registry.ts",`const adapters = { hcaptcha: hcaptchaAdapter };
export function resolveAdapter(id: string){ return adapters[id] ?? null; }`);
    await file(root,"src/app/api/contact/route.ts",`export function readToken(body: unknown){
  if (typeof body !== "object" || body === null) return null;
  return body;
}
export async function POST(request: Request){
  const captcha = readToken(await request.json());
  if (!captcha) return Response.json({ message: "Captcha failed" }, { status: 400 });
  const response = await fetch("https://example.test/contact", { method: "POST" });
  return response;
}`);
    const registry=await analyzeSourceFile(root,"src/lib/captcha/captcha-registry.ts");
    assert.ok(registry.some((item)=>item.type==="module_contract"&&item.content.includes("hcaptcha")));
    assert.ok(registry.some((item)=>item.type==="module_contract"&&item.content.includes("nullish")));
    const route=await analyzeSourceFile(root,"src/app/api/contact/route.ts");
    assert.ok(route.some((item)=>item.type==="module_contract"&&item.content.includes("return null")));
    const error=route.find((item)=>item.type==="error_handling"&&item.content.includes("Captcha failed"));
    assert.ok(error?.content.includes("when !captcha"));
    assert.ok(error?.startLine&&error.endLine&&error.sourceSymbol==="POST");
    const request=route.find((item)=>item.type==="api_dependency"&&item.content.includes("example.test/contact"));
    assert.equal(request?.sourceSymbol,"POST","local response variables must not replace their owning handler symbol");
  } finally { await rm(root,{recursive:true,force:true}); }
});
