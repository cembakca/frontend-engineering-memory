import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractSymbolGraph, type GraphEdge } from "../src/analyzers/symbol-graph.js";

const TSCONFIG=JSON.stringify({compilerOptions:{moduleResolution:"Bundler",module:"ESNext",jsx:"preserve",baseUrl:".",paths:{"@/*":["src/*"]}}});

async function file(root:string,relative:string,content:string):Promise<void> {
  const target=path.join(root,relative);
  await mkdir(path.dirname(target),{recursive:true});
  await writeFile(target,content);
}

function find(edges:GraphEdge[],type:string,predicate:(edge:GraphEdge)=>boolean):GraphEdge|undefined {
  return edges.find((edge)=>edge.type===type&&predicate(edge));
}

async function withRepo(build:(root:string)=>Promise<void>,files:string[],routes:string[]=[]):Promise<GraphEdge[]> {
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-graph-"));
  try {
    await file(root,"tsconfig.json",TSCONFIG);
    await build(root);
    return await extractSymbolGraph(root,files,routes);
  } finally { await rm(root,{recursive:true,force:true}); }
}

test("resolves a call through a barrel re-export to the declaring module",async()=>{
  const edges=await withRepo(async(root)=>{
    await file(root,"src/lib/captcha/get-token.ts","export async function getCaptchaAuth(){ return null }");
    await file(root,"src/lib/captcha/index.ts",`export { getCaptchaAuth } from "./get-token";`);
    await file(root,"src/components/Form.tsx",
      `import { getCaptchaAuth } from "@/lib/captcha";\nexport async function submit(){ await getCaptchaAuth(); }`);
  },["src/lib/captcha/get-token.ts","src/lib/captcha/index.ts","src/components/Form.tsx"]);

  const call=find(edges,"calls",(edge)=>edge.from==="src/components/Form.tsx#submit");
  assert.equal(call?.to,"src/lib/captcha/get-token.ts#getCaptchaAuth","the barrel must not absorb the edge");
});

test("resolves a request constant into a submits-to edge on a known route",async()=>{
  const edges=await withRepo(async(root)=>{
    await file(root,"src/components/ContactForm.tsx",
      `const INSERT_COMMENT_URL = "/api/pages/aboutus/insertcomment";\n`+
      `export async function handleSubmit(){ await fetch(INSERT_COMMENT_URL,{ method:"POST" }); }`);
  },["src/components/ContactForm.tsx"],["/api/pages/aboutus/insertcomment"]);

  const edge=find(edges,"submits-to",(item)=>item.from==="src/components/ContactForm.tsx#handleSubmit");
  assert.equal(edge?.to,"/api/pages/aboutus/insertcomment");
  assert.equal(edge?.confidence,"derived");
  assert.equal(edge?.derivationRule,"constant-resolution");
});

test("keeps the config key visible in a backend endpoint assembled from a template",async()=>{
  const edges=await withRepo(async(root)=>{
    await file(root,"src/lib/gateway.ts",`export const GATEWAY_URL = process.env.GATEWAY_URL ?? "";`);
    await file(root,"src/app/api/thing/route.ts",
      `import { GATEWAY_URL } from "@/lib/gateway";\n`+
      `const SUBSCRIBE_PATH = "/customer-services/v2/subscribes";\n`+
      `export async function POST(){ return fetch(\`\${GATEWAY_URL}\${SUBSCRIBE_PATH}\`,{ method:"POST" }); }`);
  },["src/lib/gateway.ts","src/app/api/thing/route.ts"]);

  const edge=find(edges,"fetches",(item)=>item.from==="src/app/api/thing/route.ts#POST");
  assert.equal(edge?.to,"POST ${GATEWAY_URL}/customer-services/v2/subscribes");
  const reads=find(edges,"reads",(item)=>item.to==="GATEWAY_URL");
  assert.ok(reads,"the config read must be recorded on the module that touches process.env");
});

test("attributes an edge to the enclosing function, not to an inner binding",async()=>{
  const edges=await withRepo(async(root)=>{
    await file(root,"src/lib/menu.ts",
      `export async function getMenuList(){ const response = await fetch("https://gateway/menu"); return response }`);
  },["src/lib/menu.ts"]);

  const edge=find(edges,"fetches",()=>true);
  assert.equal(edge?.from,"src/lib/menu.ts#getMenuList");
  assert.notEqual(edge?.from,"src/lib/menu.ts#response");
});

test("extracts an endpoint from the repository fetcher object contract",async()=>{
  const edges=await withRepo(async(root)=>{
    await file(root,"src/api/fetcher.ts","export default async function fetcher(input:{url:string;options?:{method?:string}}){ return input }");
    await file(root,"src/api/products.ts",`import fetcher from "./fetcher";
export async function getProducts(){
  const fetchFn=()=>fetcher({url:"/pages/products",options:{method:"POST"}});
  return fetchFn();
}`);
  },["src/api/fetcher.ts","src/api/products.ts"]);

  const intoClosure=find(edges,"calls",(item)=>item.from==="src/api/products.ts#getProducts"&&item.to==="src/api/products.ts#fetchFn");
  assert.ok(intoClosure,"the exported service must reach its nested request closure");
  const edge=find(edges,"fetches",(item)=>item.from==="src/api/products.ts#fetchFn");
  assert.equal(edge?.to,"POST /pages/products");
});

test("records React Query server hydration lifecycle calls",async()=>{
  const edges=await withRepo(async(root)=>{
    await file(root,"src/providers/Hydrate.tsx","export default function Hydrate(){ return <div/> }");
    await file(root,"src/app/page.tsx",`import { dehydrate } from "@tanstack/query-core";
import Hydrate from "../providers/Hydrate";
export default async function Page(){
  const client:any={};
  await client.fetchQuery({queryKey:["products"]});
  const state=dehydrate(client);
  return <Hydrate state={state}/>;
}`);
  },["src/providers/Hydrate.tsx","src/app/page.tsx"]);

  assert.ok(find(edges,"calls",(item)=>item.to==="framework:react-query#fetchQuery"));
  assert.ok(find(edges,"calls",(item)=>item.to==="framework:react-query#dehydrate"));
  assert.ok(find(edges,"renders",(item)=>item.to==="src/providers/Hydrate.tsx#default"));
});

test("records renders edges and classifies JSX-returning exports as components",async()=>{
  const edges=await withRepo(async(root)=>{
    await file(root,"src/components/Badge.tsx","export function Badge(){ return <span/> }");
    await file(root,"src/components/Card.tsx",
      `import { Badge } from "@/components/Badge";\nexport function Card(){ return <div><Badge/></div> }`);
  },["src/components/Badge.tsx","src/components/Card.tsx"]);

  const renders=find(edges,"renders",(edge)=>edge.from==="src/components/Card.tsx#Card");
  assert.equal(renders?.to,"src/components/Badge.tsx#Badge");
  const exported=find(edges,"exports",(edge)=>edge.to==="src/components/Badge.tsx#Badge");
  assert.equal(exported?.toKind,"component");
});

test("a method call on an imported data constant is not a call edge",async()=>{
  const edges=await withRepo(async(root)=>{
    await file(root,"src/lib/contact.ts",
      `export const CONTACT_SUBJECTS = [{ id:1 }];\nexport function isOtherSubject(){ return false }`);
    await file(root,"src/components/Field.tsx",
      `import { CONTACT_SUBJECTS, isOtherSubject } from "@/lib/contact";\n`+
      `export function Field(){ isOtherSubject(); return <ul>{CONTACT_SUBJECTS.map((s)=><li key={s.id}/>)}</ul> }`);
  },["src/lib/contact.ts","src/components/Field.tsx"]);

  assert.ok(find(edges,"calls",(edge)=>edge.to==="src/lib/contact.ts#isOtherSubject"),"a real function call must be recorded");
  assert.equal(
    find(edges,"calls",(edge)=>edge.to==="src/lib/contact.ts#CONTACT_SUBJECTS"),
    undefined,
    "reading an array constant is not a call",
  );
});

test("follows a dispatch table so a registered provider is reachable",async()=>{
  const edges=await withRepo(async(root)=>{
    await file(root,"src/lib/captcha/providers/hcaptcha.ts","export const hcaptchaAdapter = { id:\"hcaptcha\", async execute(){ return null } };");
    await file(root,"src/lib/captcha/registry.ts",
      `import { hcaptchaAdapter } from "@/lib/captcha/providers/hcaptcha";\n`+
      `const adapters = { hcaptcha: hcaptchaAdapter };\n`+
      `export function resolveCaptchaAdapter(id:string){ return adapters[id as keyof typeof adapters] ?? null }`);
  },["src/lib/captcha/providers/hcaptcha.ts","src/lib/captcha/registry.ts"]);

  const intoAdapter=find(edges,"references",(edge)=>edge.to==="src/lib/captcha/providers/hcaptcha.ts#hcaptchaAdapter");
  assert.equal(intoAdapter?.from,"src/lib/captcha/registry.ts#adapters","a module-level binding is a node, not the bare file");
  const intoTable=find(edges,"references",(edge)=>edge.to==="src/lib/captcha/registry.ts#adapters");
  assert.equal(intoTable?.from,"src/lib/captcha/registry.ts#resolveCaptchaAdapter","the same-module hop must close the chain");
});

test("a nested binding never becomes a node, a module-level one always does",async()=>{
  const edges=await withRepo(async(root)=>{
    await file(root,"src/lib/thing.ts","export const TABLE = { a:1 };\nexport function use(){ const local = TABLE; return local }");
  },["src/lib/thing.ts"]);

  assert.ok(find(edges,"references",(edge)=>edge.from==="src/lib/thing.ts#use"),"the enclosing function holds the edge");
  assert.equal(find(edges,"references",(edge)=>edge.from.endsWith("#local")),undefined,"a nested binding is not a node");
});

test("classifies Server Functions and connects cache tags and invalidations",async()=>{
  const edges=await withRepo(async(root)=>{
    await file(root,"src/app/actions.ts",`"use server";
import { cacheTag, revalidateTag } from "next/cache";
async function readProducts(){ cacheTag("products"); return []; }
async function saveProduct(){ revalidateTag("products", "max"); }
export { readProducts, saveProduct };`);
  },["src/app/actions.ts"]);

  const exported=find(edges,"exports",(edge)=>edge.to.endsWith("#saveProduct"));
  assert.equal(exported?.toKind,"server-function");
  const tags=find(edges,"tags",(edge)=>edge.from.endsWith("#readProducts"));
  assert.equal(tags?.to,"tag:products");
  const invalidates=find(edges,"invalidates",(edge)=>edge.from.endsWith("#saveProduct"));
  assert.equal(invalidates?.to,"tag:products");
});
