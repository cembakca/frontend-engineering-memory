import assert from "node:assert/strict";
import test from "node:test";
import type { GraphEdge, GraphEdgeType, GraphNodeKind } from "../src/analyzers/symbol-graph.js";
import { traceImpact } from "../src/retrieval/impact.js";

function edge(type:GraphEdgeType,from:string,to:string,fromKind:GraphNodeKind="symbol",toKind:GraphNodeKind="symbol",line=1):GraphEdge {
  return {type,from,to,fromKind,toKind,filePath:from.split("#")[0]!,symbol:from.split("#")[1] ?? null,startLine:line,confidence:"observed"};
}

const EDGES:GraphEdge[]=[
  edge("exports","src/lib/base.ts","src/lib/base.ts#value","module","symbol"),
  edge("references","src/lib/use.ts#derive","src/lib/base.ts#value","symbol","symbol",4),
  edge("calls","src/components/View.tsx#View","src/lib/use.ts#derive","component","symbol",8),
  edge("renders","src/app/page.tsx#Page","src/components/View.tsx#View","symbol","component",6),
  edge("fetches","src/lib/use.ts#derive","GET ${API_URL}/items","symbol","backend-endpoint",12),
  edge("reads","src/lib/base.ts#value","API_URL","symbol","config",2),
  edge("reads","src/lib/base.ts#value","INDEPENDENT_KEY","symbol","config",3),
  edge("validated-by","src/lib/use.ts#derive","test/use.test.ts#derives values","symbol","test",9),
  edge("submits-to","src/components/Other.tsx#Other","/api/other","component","route",3),
];

const ROUTES=[
  {route:"/",sourceFile:"src/app/page.tsx",routeType:"page"},
  {route:"/api/other",sourceFile:"src/app/api/other/route.ts",routeType:"route-handler"},
];

test("walks dependency edges in reverse and retains evidence",()=>{
  const impact=traceImpact(EDGES,"src/lib/base.ts#value",{routes:ROUTES});
  assert.deepEqual(impact.steps.map((step)=>step.affected),[
    "src/lib/use.ts#derive","src/components/View.tsx#View","src/app/page.tsx#Page",
  ]);
  assert.equal(impact.steps[0]?.dependency,"src/lib/base.ts#value");
  assert.equal(impact.steps[0]?.file,"src/lib/use.ts");
  assert.equal(impact.steps[0]?.line,4);
});

test("a file seed includes every symbol declared by that module",()=>{
  const impact=traceImpact(EDGES,"src/lib/base.ts",{routes:ROUTES});
  assert.ok(impact.files.includes("src/lib/use.ts"));
  assert.ok(impact.components.includes("src/components/View.tsx#View"));
  assert.deepEqual(impact.routes,["/"]);
});

test("collects external effects and validating tests of affected symbols",()=>{
  const impact=traceImpact(EDGES,"src/lib/base.ts#value");
  assert.deepEqual(impact.endpoints,["GET ${API_URL}/items"]);
  assert.deepEqual(impact.tests,["test/use.test.ts#derives values"]);
  const configImpact=traceImpact(EDGES,"API_URL");
  assert.deepEqual(configImpact.config,["API_URL"],"sibling config reads are not affected config");
});

test("does not follow downstream submits-to edges as if handlers depended on a component",()=>{
  const impact=traceImpact(EDGES,"src/components/Other.tsx#Other",{routes:ROUTES});
  assert.equal(impact.routes.includes("/api/other"),false);
  assert.equal(impact.apiRoutes.length,0);
});

test("reports depth and step budget truncation",()=>{
  const byDepth=traceImpact(EDGES,"src/lib/base.ts#value",{maxDepth:1});
  assert.equal(byDepth.steps.length,1);
  assert.equal(byDepth.truncated,true);
  const bySteps=traceImpact(EDGES,"src/lib/base.ts#value",{maxSteps:1});
  assert.equal(bySteps.steps.length,1);
  assert.equal(bySteps.truncated,true);
});
