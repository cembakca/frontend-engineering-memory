import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanRoutes } from "../src/analyzers/routes.js";

async function file(root:string,relative:string,content:string){
  const target=path.join(root,relative); await mkdir(path.dirname(target),{recursive:true}); await writeFile(target,content);
}

test("discovers App and Pages Router routes with rendering signals",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-routes-"));
  try {
    await file(root,"src/app/(public)/page.tsx","export default function Page(){ return null }");
    await file(root,"src/app/account/[id]/page.tsx","import { cookies } from 'next/headers'; export default async function Page(){ await cookies(); return null }");
    await file(root,"pages/index.tsx","export default function Home(){ return null }");
    await file(root,"pages/blog/[slug].tsx","export async function getServerSideProps(){ return { props:{} } } export default function P(){return null}");
    await file(root,"pages/api/hello.ts","export default function handler(){}");
    const routes=await scanRoutes(root);
    const by=(route:string,router:string)=>routes.find((r)=>r.route===route&&r.routerType===router);
    assert.equal(by("/","app")?.renderingMode,"rsc");
    assert.deepEqual(by("/","app")?.layoutChain,[]);
    assert.equal(by("/account/[id]","app")?.renderingMode,"dynamic-ssr");
    assert.equal(by("/blog/[slug]","pages")?.renderingMode,"ssr");
    assert.equal(by("/api/hello","pages")?.routeType,"api");
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("inherits route behavior through layouts and local imports",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-route-graph-"));
  try {
    await file(root,"tsconfig.json",JSON.stringify({compilerOptions:{moduleResolution:"Bundler",module:"ESNext",jsx:"preserve"}}));
    await file(root,"src/app/layout.tsx","import { readSession } from './session'; export default async function Layout({children}){ await readSession(); return children }");
    await file(root,"src/app/session.ts","import { cookies } from 'next/headers'; export async function readSession(){ return (await cookies()).get('access_token') }");
    await file(root,"src/app/dashboard/page.tsx","export default function Page(){ return null }");
    const route=(await scanRoutes(root)).find((item)=>item.route==="/dashboard");
    assert.equal(route?.renderingMode,"dynamic-ssr");
    assert.equal(route?.authRequired,true);
    assert.ok(route?.behaviorFiles.includes("src/app/layout.tsx"));
    assert.ok(route?.behaviorFiles.includes("src/app/session.ts"));
    assert.ok(route?.evidence.some((item)=>item.includes("src/app/session.ts: cookies()")));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("normalizes all Next.js intercepting route conventions",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-intercepts-"));
  try {
    await file(root,"src/app/@auth/(.)login/page.tsx","export default function Page(){return null}");
    await file(root,"src/app/feed/@modal/(..)photo/[id]/page.tsx","export default function Page(){return null}");
    await file(root,"src/app/a/b/@modal/(..)(..)photo/page.tsx","export default function Page(){return null}");
    await file(root,"src/app/a/@modal/(...)settings/page.tsx","export default function Page(){return null}");
    const routes=(await scanRoutes(root)).map((route)=>route.route).sort();
    assert.deepEqual(routes,["/login","/photo","/photo/[id]","/settings"]);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("maps middleware, client boundaries, data sources, cache and SEO onto routes",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-route-behavior-"));
  try {
    await file(root,"tsconfig.json",JSON.stringify({compilerOptions:{moduleResolution:"Bundler",module:"ESNext",jsx:"preserve"}}));
    await file(root,"src/middleware.ts",`import { NextResponse } from "next/server";
export function middleware(request){ return request.cookies.get("access_token") ? NextResponse.next() : NextResponse.redirect(new URL("/login",request.url)) }
export const config={matcher:["/dashboard/:path*"]};`);
    await file(root,"src/app/layout.tsx","export const metadata={title:'Fixture'}; export default function Layout({children}){ return children }");
    await file(root,"src/app/dashboard/page.tsx","import Panel from './panel'; import { loadAccounts } from './service'; export default async function Page(){ await loadAccounts(); return <Panel/> }");
    await file(root,"src/app/dashboard/panel.tsx",`"use client"; export default function Panel(){ return null }`);
    await file(root,"src/app/dashboard/service.ts",`import axios from "axios"; export async function loadAccounts(){ return axios.get(process.env.ACCOUNTS_API + "/accounts",{cache:"no-store"}) }`);
    await file(root,"src/app/dashboard/opengraph-image.tsx","export default function Image(){ return null }");

    const route=(await scanRoutes(root)).find((item)=>item.route==="/dashboard");
    assert.ok(route);
    assert.equal(route.serverComponent,true);
    assert.equal(route.middlewareMatched,true);
    assert.equal(route.authRequired,true);
    assert.deepEqual(route.middlewareMatchers,["/dashboard/:path*"]);
    assert.ok(route.clientBoundaries.includes("src/app/dashboard/panel.tsx"));
    assert.ok(route.dataSources.some((item)=>item.includes("ACCOUNTS_API")));
    assert.ok(route.cacheBehavior.some((item)=>item.includes("no-store")));
    assert.equal(route.seoType,"file-based");
    assert.equal(route.metadataSource,"src/app/dashboard/opengraph-image.tsx");
    assert.ok(route.behaviorFiles.includes("src/middleware.ts"));
    assert.ok(route.behaviorFiles.includes("src/app/dashboard/opengraph-image.tsx"));
    assert.ok(route.dependencies.some((item)=>item.dependencyType==="http" && item.sourceSymbol==="loadAccounts" && item.startLine===1));
    assert.ok(route.dependencies.some((item)=>item.dependencyType==="config" && item.name==="ACCOUNTS_API"));
  } finally { await rm(root,{recursive:true,force:true}); }
});
