import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractSymbolGraph, type GraphEdge, type GraphEdgeType } from "../src/analyzers/symbol-graph.js";
import { traceFlow, routeEntriesFrom } from "../src/retrieval/flow.js";

const TSCONFIG=JSON.stringify({compilerOptions:{moduleResolution:"Bundler",module:"ESNext",jsx:"preserve",baseUrl:".",paths:{"@/*":["src/*"]}}});

function edge(type:GraphEdgeType,from:string,to:string,startLine:number):GraphEdge {
  return {type,from,fromKind:"symbol",to,toKind:type==="fetches" ? "backend-endpoint" : "symbol",
    filePath:from.split("#")[0]!,symbol:from.split("#")[1] ?? null,startLine,confidence:"observed"};
}

async function file(root:string,relative:string,content:string):Promise<void> {
  const target=path.join(root,relative);
  await mkdir(path.dirname(target),{recursive:true});
  await writeFile(target,content);
}

/** A form that validates, mints a captcha, posts to its own route, and the route calls upstream. */
async function submitFixture(root:string):Promise<void> {
  await file(root,"tsconfig.json",TSCONFIG);
  await file(root,"src/lib/validate.ts",
    "const LIMIT = 10;\n"+
    "function trimTo(value:string){ return value.slice(0,LIMIT) }\n"+
    "export function parseForm(value:string){ return trimTo(value) }\n"+
    "export function validateForm(value:string){ return trimTo(value).length>0 }");
  await file(root,"src/lib/captcha.ts","export async function getToken(){ return \"t\" }");
  await file(root,"src/lib/gateway.ts","export const GATEWAY_URL = process.env.GATEWAY_URL ?? \"\";");
  await file(root,"src/components/Form.tsx",
    `import { parseForm, validateForm } from "@/lib/validate";\n`+
    `import { getToken } from "@/lib/captcha";\n`+
    `const SUBMIT_URL = "/api/thing";\n`+
    `export async function handleSubmit(raw:string){\n`+
    `  const values = parseForm(raw);\n`+
    `  validateForm(raw);\n`+
    `  const token = await getToken();\n`+
    `  await fetch(SUBMIT_URL,{ method:"POST", body: JSON.stringify({ values, token }) });\n`+
    `}`);
  await file(root,"src/app/api/thing/route.ts",
    `import { GATEWAY_URL } from "@/lib/gateway";\n`+
    `export async function POST(){ return fetch(\`\${GATEWAY_URL}/thing\`,{ method:"POST" }) }`);
}

const FIXTURE_FILES=["src/lib/validate.ts","src/lib/captcha.ts","src/lib/gateway.ts","src/components/Form.tsx","src/app/api/thing/route.ts"];

async function traceFixture(options:Parameters<typeof traceFlow>[2]={}):Promise<ReturnType<typeof traceFlow>> {
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-flow-"));
  try {
    await submitFixture(root);
    const routeFiles=new Map([["/api/thing","src/app/api/thing/route.ts"]]);
    const edges=await extractSymbolGraph(root,FIXTURE_FILES,[...routeFiles.keys()]);
    return traceFlow(edges,"src/components/Form.tsx#handleSubmit",{routeEntries:routeEntriesFrom(edges,routeFiles),...options});
  } finally { await rm(root,{recursive:true,force:true}); }
}

test("orders steps by source position so the flow reads as execution order",async()=>{
  const trace=await traceFixture();
  const chain=trace.steps.filter((step)=>step.depth===0).map((step)=>step.to);
  assert.deepEqual(chain,[
    "src/lib/validate.ts#parseForm",
    "src/lib/validate.ts#validateForm",
    "src/lib/captcha.ts#getToken",
    "/api/thing",
  ]);
});

test("marks the client-to-server boundary and continues into the handler",async()=>{
  const trace=await traceFixture();
  const submit=trace.steps.find((step)=>step.edge==="submits-to");
  assert.equal(submit?.to,"/api/thing");
  assert.equal(submit?.boundary,"client-to-server");
  assert.equal(submit?.confidence,"derived","the target came from a constant, not a literal");

  const upstream=trace.steps.find((step)=>step.edge==="fetches");
  assert.ok(upstream,"the flow must not stop at the route boundary");
  assert.ok((upstream!.order)>(submit!.order),"the upstream call comes after the submit");
});

test("prunes helper internals that reach nothing significant",async()=>{
  const trace=await traceFixture();
  assert.ok(trace.prunedSteps>0,"intra-module helper calls must be dropped");
  assert.equal(
    trace.steps.find((step)=>step.to.endsWith("#trimTo")),
    undefined,
    "an intra-module helper call is implementation detail, not a flow step",
  );
  assert.equal(trace.steps.find((step)=>step.to.endsWith("#LIMIT")),undefined);
});

test("collects the upstream endpoints and config keys the flow depends on",async()=>{
  const trace=await traceFixture();
  assert.deepEqual(trace.endpoints,["POST ${GATEWAY_URL}/thing"]);
  assert.deepEqual(trace.config,["GATEWAY_URL"]);
});

test("respects the step budget and reports truncation",async()=>{
  const trace=await traceFixture({maxSteps:2});
  assert.equal(trace.steps.length,2);
  assert.equal(trace.truncated,true);
});

test("data focus keeps only branches that reach an external boundary",async()=>{
  const edges=[
    edge("calls","page#Page","logger#log",1),
    edge("calls","logger#log","sanitize#meta",2),
    edge("calls","page#Page","service#getProducts",3),
    edge("calls","service#getProducts","service#fetchFn",4),
    edge("fetches","service#fetchFn","GET /products",5),
  ];
  const trace=traceFlow(edges,"page#Page",{focus:"data"});
  assert.deepEqual(trace.steps.map((item)=>item.to),["service#getProducts","service#fetchFn","GET /products"]);
  assert.deepEqual(trace.endpoints,["GET /products"]);
});
