import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractVerificationGraph } from "../src/analyzers/verification-graph.js";

async function file(root:string,relative:string,content:string):Promise<void> {
  const target=path.join(root,relative);
  await mkdir(path.dirname(target),{recursive:true});
  await writeFile(target,content);
}

async function fixture(withTests=true):Promise<{root:string;files:string[]}> {
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-verification-"));
  await file(root,"tsconfig.json",JSON.stringify({compilerOptions:{moduleResolution:"Bundler",module:"ESNext",baseUrl:".",paths:{"@/*":["src/*"]}}}));
  await file(root,"package.json",JSON.stringify({scripts:{test:"vitest run",typecheck:"tsc --noEmit",lint:"eslint .",build:"next build",dev:"next dev"}},null,2));
  await file(root,"src/lib/math.ts","export function add(a:number,b:number){ return a+b }");
  await file(root,"src/app/api/sum/route.ts","export function POST(){ return null }");
  if (withTests) await file(root,"test/math.test.ts",
    `import { describe, it } from "vitest";\n`+
    `import { add } from "@/lib/math";\n`+
    `import { POST } from "@/app/api/sum/route";\n`+
    `describe("math",()=>{\n`+
    `  it("adds",()=>{ add(1,2) });\n`+
    `  it("posts",()=>{ POST() });\n`+
    `});`);
  return {root,files:withTests ? ["test/math.test.ts"] : []};
}

test("extracts runnable verification commands and ignores dev scripts",async()=>{
  const {root,files}=await fixture();
  try {
    const result=await extractVerificationGraph(root,files);
    assert.deepEqual(result.commands.map((item)=>item.kind),["test","typecheck","lint","build"]);
    assert.equal(result.commands.some((item)=>item.name==="dev"),false);
    assert.ok(result.commands.every((item)=>item.file==="package.json"&&item.line>0));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("does not mistake environment names or build variants for test runners",async()=>{
  const {root}=await fixture(false);
  try {
    await file(root,"package.json",JSON.stringify({scripts:{dev:"env-cmd -f .env.test next dev","build:test":"cp .env.test .env.production && run-s build"}},null,2));
    const result=await extractVerificationGraph(root,[]);
    assert.deepEqual(result.commands.map((item)=>[item.name,item.kind]),[["build:test","build"]]);
    assert.ok(result.gaps.some((gap)=>gap.kind==="missing-test-command"));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("creates symbol-precise validated-by edges for imports used inside each case",async()=>{
  const {root,files}=await fixture();
  try {
    const result=await extractVerificationGraph(root,files);
    assert.deepEqual(result.tests.map((item)=>item.title),["math > adds","math > posts"]);
    assert.deepEqual(result.tests[0]?.targets,["src/lib/math.ts#add"]);
    assert.ok(result.edges.some((edge)=>edge.from==="src/lib/math.ts#add"&&edge.to.endsWith("#math > adds")));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("maps a tested route-handler export back to the route identity",async()=>{
  const {root,files}=await fixture();
  try {
    const result=await extractVerificationGraph(root,files,{routes:[{route:"/api/sum",sourceFile:"src/app/api/sum/route.ts"}]});
    assert.ok(result.edges.some((edge)=>edge.from==="/api/sum"&&edge.fromKind==="route"));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("makes missing test infrastructure and uncovered targets explicit gaps",async()=>{
  const {root,files}=await fixture(false);
  try {
    await file(root,"package.json",JSON.stringify({scripts:{lint:"eslint .",build:"next build"}},null,2));
    const result=await extractVerificationGraph(root,files,{targets:[{key:"/api/sum",kind:"route",file:"src/app/api/sum/route.ts"}]});
    assert.deepEqual(result.gaps.map((gap)=>gap.kind),["missing-test-command","missing-test-files","unvalidated-target"]);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("does not credit an imported target to a case that never uses it",async()=>{
  const {root,files}=await fixture();
  try {
    const result=await extractVerificationGraph(root,files);
    const addTest=result.tests.find((item)=>item.title.endsWith("adds"));
    const postTest=result.tests.find((item)=>item.title.endsWith("posts"));
    assert.equal(addTest?.targets.includes("src/app/api/sum/route.ts#POST"),false);
    assert.equal(postTest?.targets.includes("src/lib/math.ts#add"),false);
  } finally { await rm(root,{recursive:true,force:true}); }
});
