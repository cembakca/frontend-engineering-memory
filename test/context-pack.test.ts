import assert from "node:assert/strict";
import test from "node:test";
import { compileContextPack } from "../src/retrieval/context-pack.js";
import type { FlowTrace } from "../src/retrieval/flow.js";
import type { ImpactTrace } from "../src/retrieval/impact.js";
import { buildAgentContext } from "../src/retrieval/context.js";
import { MemoryDatabase } from "../src/memory/database.js";

const FLOW:FlowTrace={seed:"Form#submit",steps:[{order:1,depth:0,from:"Form#submit",edge:"submits-to",to:"/api/thing",file:"src/Form.tsx",line:10,symbol:"submit",confidence:"observed",boundary:"client-to-server"}],endpoints:["POST ${API_URL}/thing"],config:["API_URL"],prunedSteps:2,truncated:false};
const IMPACT:ImpactTrace={seed:"API_URL",steps:[{depth:1,affected:"src/route.ts#POST",affectedKind:"symbol",via:"reads",dependency:"API_URL",file:"src/route.ts",line:4,symbol:"POST",confidence:"observed"}],files:["src/route.ts"],symbols:["src/route.ts#POST"],components:[],routes:["/api/thing"],apiRoutes:["/api/thing"],config:["API_URL"],endpoints:["POST ${API_URL}/thing"],tests:[],truncated:false};

test("compiles a discriminated flow pack with boundary and evidence",()=>{
  const pack=compileContextPack({kind:"flow",query:"flow?",repository:"repo",snapshotSha:"sha",trace:FLOW});
  assert.equal(pack.kind,"flow");
  if (pack.kind!=="flow") return;
  assert.equal(pack.steps[0]?.boundary,"client-to-server");
  assert.equal(pack.steps[0]?.evidence.file,"src/Form.tsx");
  assert.deepEqual(pack.endpoints,["POST ${API_URL}/thing"]);
  assert.deepEqual(pack.answerContract.derivedRelations,["steps","endpoints","config"]);
  assert.equal(pack.answerContract.uncertainty.level,"none");
});

test("keeps impact summary separate from relation evidence",()=>{
  const pack=compileContextPack({kind:"impact",query:"impact?",repository:"repo",trace:IMPACT});
  assert.equal(pack.kind,"impact");
  if (pack.kind!=="impact") return;
  assert.deepEqual(pack.affected.apiRoutes,["/api/thing"]);
  assert.equal(pack.relations[0]?.dependency,"API_URL");
  assert.equal((pack as any).steps,undefined);
});

test("implementation pack carries exemplars, edit surface and explicit verification gaps",()=>{
  const pack=compileContextPack({kind:"implementation",query:"add",repository:"repo",impact:IMPACT,
    exemplars:[{id:1,repository:"repo",type:"api_dependency",subject:"POST",content:"existing pattern",sourceFile:"src/route.ts",commitSha:"sha",score:.8,channels:["fts"],canonicalEntity:"repo:symbol:POST"}],
    verification:{commands:[{key:"script:lint",name:"lint",kind:"lint",command:"eslint",file:"package.json",line:10}],tests:[],edges:[],gaps:[{kind:"missing-test-command",reason:"no tests"}]}});
  assert.equal(pack.kind,"implementation");
  if (pack.kind!=="implementation") return;
  assert.equal(pack.exemplars[0]?.entity,"repo:symbol:POST");
  assert.deepEqual(pack.editSurface.routes,["/api/thing"]);
  assert.equal(pack.verification.gaps[0]?.kind,"missing-test-command");
  assert.equal(pack.answerContract.uncertainty.level,"partial");
  assert.ok(pack.answerContract.missingEvidence.some((item)=>item.path==="verification"));
});

test("verification-first packs preserve test gaps before optional exemplars",()=>{
  const noisy=Array.from({length:20},(_,index)=>({id:index+1,repository:"repo",type:"error_handling" as const,
    subject:`error-${index}`,content:"x".repeat(800),sourceFile:`src/error-${index}.ts`,commitSha:"sha",confidence:"verified" as const,
    score:.5,channels:["fts" as const],canonicalEntity:`repo:error:${index}`}));
  const pack=compileContextPack({kind:"implementation",query:"test strategy",repository:"repo",snapshotSha:"sha",
    exemplars:noisy,verificationFirst:true,
    verification:{commands:[{key:"script:build",name:"build",kind:"build",command:"next build",file:"package.json",line:8}],tests:[],edges:[],
      gaps:[{kind:"missing-test-command",reason:"package.json has no test runner script"},{kind:"missing-test-files",reason:"No test files"}]},
  },{maxChars:2_000});
  assert.deepEqual(pack.verification.gaps.map((item)=>item.kind),["missing-test-command","missing-test-files"]);
  assert.equal(pack.verification.commands[0]?.evidence.file,"package.json");
  assert.ok(pack.budget.omitted.exemplars>0);
});

test("debug and change-review schemas expose only task-relevant sections",()=>{
  const debug=compileContextPack({kind:"debug",query:"why",repository:"repo",facts:[],trace:FLOW,checks:["check body"]});
  assert.equal(debug.kind,"debug");
  assert.equal((debug as any).affected,undefined);
  const change=compileContextPack({kind:"change-review",query:"diff",repository:"repo",changes:[{operation:"UPDATE",entity:"API_URL",file:"src/config.ts"}],impact:IMPACT});
  assert.equal(change.kind,"change-review");
  assert.equal((change as any).failurePath,undefined);
});

test("enforces the serialized character budget and reports omitted sections",()=>{
  const trace:FlowTrace={...FLOW,steps:Array.from({length:100},(_,index)=>({...FLOW.steps[0]!,order:index+1,to:`/api/${index}-${"x".repeat(80)}`}))};
  const pack=compileContextPack({kind:"flow",query:"flow?",repository:"repo",trace},{maxChars:1_000});
  assert.ok(JSON.stringify(pack).length<=1_000);
  assert.equal(pack.budget.truncated,true);
  assert.ok((pack.budget.omitted.steps ?? 0)>0);
  assert.equal(pack.budget.usedChars,JSON.stringify(pack).length);
});

test("clamps budgets and estimates tokens without claiming model billing",()=>{
  const pack=compileContextPack({kind:"impact",query:"impact?",repository:"repo",trace:IMPACT},{maxChars:100});
  assert.equal(pack.budget.maxChars,1_000);
  assert.equal(pack.budget.estimatedTokens,Math.ceil(pack.budget.usedChars/3.5));
});

test("labels inferred claims and gives structured targeted source fallback",()=>{
  const pack=compileContextPack({kind:"debug",query:"why",repository:"repo",facts:[{
    id:2,repository:"repo",type:"business_rule",subject:"possible cause",content:"may reject stale tokens",sourceFile:null,
    commitSha:"sha",score:.4,channels:["vector"],confidence:"inferred",
  }],sourceFallback:["src/token.ts"]});
  assert.equal(pack.kind,"debug");
  if (pack.kind!=="debug") return;
  assert.equal(pack.facts[0]?.claimKind,"inference");
  assert.deepEqual(pack.answerContract.inferences,["facts[claimKind=inference]"]);
  assert.equal(pack.answerContract.uncertainty.level,"partial");
  assert.equal(pack.answerContract.missingEvidence[0]?.path,"facts[0]");
  assert.deepEqual(pack.answerContract.sourceFallback,[{file:"src/token.ts",reason:"missing-evidence",priority:1}]);
});

test("marks an empty unresolved pack as insufficient instead of implying an answer",()=>{
  const empty:ImpactTrace={seed:"unresolved",steps:[],files:[],symbols:[],components:[],routes:[],apiRoutes:[],config:[],endpoints:[],tests:[],truncated:false};
  const pack=compileContextPack({kind:"impact",query:"impact?",repository:"repo",trace:empty,gaps:["impact seed could not be resolved"]});
  assert.equal(pack.answerContract.uncertainty.level,"insufficient");
  assert.deepEqual(pack.answerContract.uncertainty.reasons,["impact seed could not be resolved"]);
});

test("budgets long uncertainty and fallback metadata without dropping the contract",()=>{
  const sourceFallback=Array.from({length:20},(_,index)=>`src/deep/path/${index}-${"x".repeat(80)}.tsx`);
  const pack=compileContextPack({kind:"flow",query:"flow?",repository:"repo",trace:FLOW,
    gaps:Array.from({length:10},(_,index)=>`missing relation ${index}: ${"y".repeat(80)}`),sourceFallback},{maxChars:1_000});
  assert.ok(JSON.stringify(pack).length<=1_000);
  assert.ok((pack.budget.omitted.answerContract ?? 0)>0);
  assert.equal(pack.answerContract.uncertainty.level,"partial");
  assert.ok(pack.answerContract.rules.derivedRelation.length>0);
});

test("says matches did not fit rather than reporting a miss that did not happen",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const { mkdtemp, rm }=await import("node:fs/promises");
  const os=await import("node:os");
  const path=await import("node:path");
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-budget-"));
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  try {
    memoryDb.db.prepare("INSERT INTO repositories(name,path,router_type,last_indexed_sha) VALUES(?,?,?,?)")
      .run("fixture","/fixture","app","a".repeat(40));
    const memory=memoryDb.db.prepare(
      "INSERT INTO memories(repository_id,memory_type,subject,content,confidence,created_sha,updated_sha) VALUES(1,'configuration','GATEWAY_URL',?,'verified',?,?)",
    ).run(`GATEWAY_URL configures the backend gateway. ${"detail ".repeat(120)}`,"a".repeat(40),"a".repeat(40));
    const id=Number(memory.lastInsertRowid);
    memoryDb.db.prepare("INSERT INTO memory_evidence(memory_id,file_path,start_line,end_line,commit_sha) VALUES(?,?,?,?,?)")
      .run(id,"src/config.ts",3,3,"a".repeat(40));
    memoryDb.db.prepare("INSERT INTO memory_fts(memory_id,repository_id,memory_type,subject,content) VALUES(?,1,'configuration','GATEWAY_URL',?)")
      .run(id,`GATEWAY_URL configures the backend gateway. ${"detail ".repeat(120)}`);

    const pack:any=await buildAgentContext(memoryDb,"GATEWAY_URL configuration",{repository:"fixture",maxChars:1000});
    assert.equal(pack.items.length,0,"the fact cannot fit this budget");
    assert.equal(pack.budgetExceeded,true);
    assert.match(pack.guidance,/exceed maxChars/);
    assert.ok(pack.answerContract.uncertainty.reasons.some((reason:string)=>reason.includes("did not fit")),
      "an empty pack must not claim nothing matched when something did");
  } finally {
    memoryDb.close();
    await rm(root,{recursive:true,force:true});
  }
});
