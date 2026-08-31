import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanRoutes } from "../src/analyzers/routes.js";
import { OPEN_SEMANTIC_GAPS } from "../src/analyzers/semantic-gaps.js";
import type { RouteRecord } from "../src/types.js";

/**
 * RCE-008 — analyzer semantic correctness pack.
 *
 * These are characterization tests. Each case records what a correct analyzer
 * MUST produce (`expected`) next to what this analyzer produces today
 * (`current`). The assertion is against `current`, so the suite stays green
 * while the gaps are open, and turns red the moment behaviour changes.
 *
 * When you fix the analyzer a case will fail with both strings in the message.
 * That failure is the signal: promote `current` to `expected` and drop the
 * entry from OPEN_GAPS. Never silence a case by editing `expected`.
 */

const TSCONFIG=JSON.stringify({compilerOptions:{moduleResolution:"Bundler",module:"ESNext",jsx:"preserve",baseUrl:".",paths:{"@/*":["src/*"]}}});

async function file(root:string,relative:string,content:string):Promise<void> {
  const target=path.join(root,relative);
  await mkdir(path.dirname(target),{recursive:true});
  await writeFile(target,content);
}

interface SemanticCase {
  id:string;
  title:string;
  /** The semantics a correct analyzer must record. */
  expected:string;
  /** What this analyzer records today. Change only together with the fix. */
  current:string;
  build:(root:string)=>Promise<void>;
  observe:(routes:RouteRecord[])=>string;
}

function route(routes:RouteRecord[],value:string):RouteRecord|undefined {
  return routes.find((item)=>item.route===value);
}

const cases:SemanticCase[]=[
  {
    id:"RCE-008-A",
    title:"a page whose only statement is redirect() is not a rendered page",
    expected:"redirect:/hakkimizda",
    current:"redirect:/hakkimizda",
    build:async(root)=>{
      await file(root,"src/app/page.tsx",`import { redirect } from "next/navigation";\nexport default function Page(){ redirect("/hakkimizda"); }`);
    },
    observe:(routes)=>{
      const record=route(routes,"/");
      const redirectSignal=record?.controlFlow.find((item)=>item.kind==="redirect"&&!item.conditional);
      return redirectSignal ? `redirect:${redirectSignal.target}` : record?.renderingMode ?? "missing";
    },
  },
  {
    id:"RCE-008-B",
    title:"MANDATORY REGRESSION — pilot '/': redirect page must not inherit ISR from a reachable helper",
    expected:"redirect:/hakkimizda",
    current:"redirect:/hakkimizda",
    build:async(root)=>{
      await file(root,"src/app/layout.tsx",`import { getMenu } from "@/lib/menu";\nexport default async function L({children}){ await getMenu(); return children }`);
      await file(root,"src/lib/menu.ts",`export async function getMenu(){ return fetch("http://gateway/menu",{ next:{ revalidate: 900 } }) }`);
      await file(root,"src/app/page.tsx",`import { redirect } from "next/navigation";\nexport default function Page(){ redirect("/hakkimizda"); }`);
    },
    observe:(routes)=>{
      const record=route(routes,"/");
      const redirectSignal=record?.controlFlow.find((item)=>item.kind==="redirect"&&!item.conditional);
      return redirectSignal ? `redirect:${redirectSignal.target}` : record?.renderingMode ?? "missing";
    },
  },
  {
    id:"RCE-008-C",
    title:"force-static forces prerendering, so a helper calling cookies() cannot make the route dynamic",
    // Next.js 16 docs, caching-without-cache-components: "'force-static' forces
    // prerendering and caches data by making cookies, headers() and
    // useSearchParams() return empty values."
    expected:"static",
    current:"static",
    build:async(root)=>{
      await file(root,"src/lib/session.ts",`import { cookies } from "next/headers";\nexport async function read(){ return (await cookies()).get("x") }`);
      await file(root,"src/app/kariyer/page.tsx",`import { read } from "@/lib/session";\nexport const dynamic = "force-static";\nexport default async function P(){ await read(); return null }`);
    },
    observe:(routes)=>route(routes,"/kariyer")?.renderingMode ?? "missing",
  },
  {
    id:"RCE-008-H",
    title:"the route segment directive itself must survive into the record, not just a vague evidence string",
    expected:"dynamic=force-static",
    current:"dynamic=force-static",
    build:async(root)=>{
      await file(root,"src/app/ekibimiz/page.tsx",`export const dynamic = "force-static";\nexport default function P(){ return null }`);
    },
    observe:(routes)=>{
      const record=route(routes,"/ekibimiz");
      return record?.segmentConfig?.dynamic ? `dynamic=${record.segmentConfig.dynamic}` : "directive not preserved";
    },
  },
  {
    id:"RCE-008-D",
    title:"a page that calls notFound() can serve a 404 and must record it",
    expected:"not-found:conditional",
    current:"not-found:conditional",
    build:async(root)=>{
      await file(root,"src/app/[slug]/page.tsx",`import { notFound } from "next/navigation";\nexport default async function P({params}){ const { slug }=await params; if (slug!=="ok") notFound(); return null }`);
    },
    observe:(routes)=>{
      const signal=route(routes,"/[slug]")?.controlFlow.find((item)=>item.kind==="not-found");
      return signal ? `not-found:${signal.conditional ? "conditional" : "always"}` : "no not-found signal";
    },
  },
  {
    id:"RCE-008-E",
    title:"next.config rewrites delegate a whole namespace to an upstream and must appear in the inventory",
    expected:"delegated:/api/pages/:path*",
    current:"only filesystem routes",
    build:async(root)=>{
      await file(root,"next.config.ts",`const nextConfig={ async rewrites(){ return [ { source:"/api/pages/:path*", destination:\`\${process.env.GATEWAY_URL}/pages/:path*\` } ] } };\nexport default nextConfig;`);
      await file(root,"src/app/api/pages/aboutus/insertcomment/route.ts",`export async function POST(){ return Response.json({ ok:true }) }`);
    },
    observe:(routes)=>routes.some((item)=>item.route.includes(":path*")) ? "delegated:/api/pages/:path*" : "only filesystem routes",
  },
  {
    id:"RCE-008-F",
    title:"a redirect page and an empty page must not produce identical records",
    expected:"distinguishable",
    current:"distinguishable",
    build:async(root)=>{
      await file(root,"src/app/redirected/page.tsx",`import { redirect } from "next/navigation";\nexport default function P(){ redirect("/target"); }`);
      await file(root,"src/app/empty/page.tsx",`export default function P(){ return null }`);
    },
    observe:(routes)=>{
      const strip=(record?:RouteRecord)=>JSON.stringify({
        mode:record?.renderingMode,
        controlFlow:record?.controlFlow,
        evidence:record?.evidence.map((item)=>item.replace(/^[^:]+:/,"")),
      });
      return strip(route(routes,"/redirected"))===strip(route(routes,"/empty")) ? "identical" : "distinguishable";
    },
  },
  {
    id:"RCE-008-G",
    title:"a classification reached because no signal was found must be marked as a default, not asserted",
    expected:"basis:default",
    current:"basis:default",
    build:async(root)=>{
      await file(root,"src/app/page.tsx",`export default function P(){ return null }`);
    },
    observe:(routes)=>{
      const record=route(routes,"/");
      return record?.renderingBasis==="default" ? "basis:default" : `basis:${record?.renderingBasis ?? "missing"}`;
    },
  },
];

/** Shared with the rollout gate so a gate can never pass while these are open. */
const OPEN_GAPS=[...OPEN_SEMANTIC_GAPS];

for (const item of cases) {
  test(`${item.id} — ${item.title}`,async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"fem-semantic-"));
    try {
      await file(root,"tsconfig.json",TSCONFIG);
      await item.build(root);
      const observed=item.observe(await scanRoutes(root));
      assert.equal(
        observed,
        item.current,
        `${item.id} behaviour changed.\n  observed: ${observed}\n  recorded: ${item.current}\n  expected by the contract: ${item.expected}\n` +
        "If this is the fix, promote `current` to `expected` and remove the id from OPEN_GAPS.",
      );
    } finally { await rm(root,{recursive:true,force:true}); }
  });
}

test("RCE-008 open-gap ledger matches the recorded cases",()=>{
  const open=cases.filter((item)=>item.current!==item.expected).map((item)=>item.id).sort();
  assert.deepEqual(
    open,
    [...OPEN_GAPS].sort(),
    `Open semantic gaps changed. Currently open: ${open.join(", ") || "none"}. Update OPEN_GAPS.`,
  );
});
