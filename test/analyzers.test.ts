import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeSourceFile, listAnalyzableSourceFiles } from "../src/analyzers/source-memory.js";
import { analyzeProjectFile } from "../src/analyzers/project-memory.js";
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

test("extracts Server Functions, cache invalidation, schemas, authorization and analytics events",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-next-semantics-"));
  try {
    await file(root,"src/app/actions.ts",`"use server";
import { revalidateTag } from "next/cache";
import { z } from "zod";
const contactSchema = z.object({ name: z.string(), email: z.string() });
export async function saveContact(formData: FormData) {
  await requireAuth("editor");
  const name = formData.get("name");
  const email = formData.get("email");
  revalidateTag("contacts", "max");
  return { name, email };
}`);
    const memories=await analyzeSourceFile(root,"src/app/actions.ts");
    const serverFunction=memories.find((item)=>item.type==="server_function");
    assert.equal(serverFunction?.sourceSymbol,"saveContact");
    assert.ok(serverFunction?.content.includes("contacts"));
    assert.ok(memories.some((item)=>item.type==="cache_invalidation"&&item.content.includes("contacts")));
    assert.ok(memories.some((item)=>item.type==="schema_contract"&&item.content.includes("name, email")));
    assert.ok(memories.some((item)=>item.type==="authorization"&&item.content.includes("editor")));

    await file(root,"src/components/track.ts",`export function trackPurchase(){
  window.dataLayer.push({ event: "purchase", orderId: "42", currency: "TRY" });
}`);
    const analytics=await analyzeSourceFile(root,"src/components/track.ts");
    assert.ok(analytics.some((item)=>item.type==="analytics_event"&&item.content.includes("purchase")&&item.content.includes("orderId, currency")));
    assert.equal(analytics.some((item)=>item.type==="analytics"),false,"an exact event replaces the generic integration-presence memory");

    await file(root,"src/components/navigation.tsx",`export function Navigation({ router, value }) {
  router.refresh();
  return value.toLocaleString("tr-TR");
}`);
    const navigation=await analyzeSourceFile(root,"src/components/navigation.tsx");
    assert.equal(navigation.some((item)=>item.type==="cache"||item.type==="cache_invalidation"),false,
      "client router.refresh and Object prototype methods are not next/cache operations");
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("does not treat a business-domain role object as an authorization check",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-domain-role-"));
  try {
    await file(root,"src/components/OpenRoles.tsx",`
      export function OpenRoles({ roles }: { roles: Array<{ department?: string; location?: string }> }) {
        return roles.map((role) => role && (role.department || role.location) ? role.department : null);
      }
    `);
    const memories=await analyzeSourceFile(root,"src/components/OpenRoles.tsx");
    assert.equal(memories.filter((item)=>item.type==="authorization").length,0);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("extracts concrete next.config rules and Next.js special files",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-next-config-"));
  try {
    await file(root,"next.config.ts",`const nextConfig = {
  output: "standalone",
  typedRoutes: true,
  async rewrites() { return [{ source: "/legacy/:path*", destination: "https://legacy.test/:path*" }]; },
  async headers() { return [{ source: "/:path*", headers: [{ key: "X-Frame-Options", value: "DENY" }] }]; }
};
export default nextConfig;`);
    const config=await analyzeProjectFile(root,"next.config.ts");
    assert.ok(config.some((item)=>item.type==="next_config"&&item.subject.endsWith(":output")&&item.content.includes("standalone")));
    assert.ok(config.some((item)=>item.type==="next_config"&&item.content.includes("/legacy/:path*")&&item.content.includes("legacy.test")));
    assert.ok(config.some((item)=>item.type==="next_config"&&item.content.includes("response headers")));

    await file(root,"src/app/account/loading.tsx","export default function Loading(){ return null }");
    const special=await analyzeSourceFile(root,"src/app/account/loading.tsx");
    assert.ok(special.some((item)=>item.type==="special_file"&&item.content.includes("loading file convention")));
  } finally { await rm(root,{recursive:true,force:true}); }
});
