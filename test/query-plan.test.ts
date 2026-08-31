import assert from "node:assert/strict";
import test from "node:test";
import { decideSecondRound, planQuery } from "../src/retrieval/query-plan.js";

test("uses exact SQL first for structured lookup and keeps semantic channels conditional",()=>{
  const plan=planQuery("`/iletisim` hangi dosyadan gelir?");
  assert.equal(plan.intent,"lookup");
  assert.equal(plan.anchors.route,"/iletisim");
  assert.deepEqual(plan.rounds[0].steps.map((item)=>item.channel),["exact-sql"]);
  assert.deepEqual(plan.rounds[1].steps.map((item)=>item.channel),["fts","vector"]);
  assert.deepEqual(planQuery("Bütün aktif route'ları listele").rounds[0].steps.map((item)=>item.channel),["exact-sql"]);
});

test("routes flow and impact questions to their graph traversals",()=>{
  const flow=planQuery("Form UI'dan backend'e hangi sırayla gider?");
  assert.deepEqual(flow.rounds[0].steps.map((item)=>item.channel),["exact-sql","graph-flow"]);
  const impact=planQuery("src/lib/menu.ts değişirse hangi route'lar etkilenir?");
  assert.deepEqual(impact.rounds[0].steps.map((item)=>item.channel),["exact-sql","graph-impact"]);
  assert.deepEqual(impact.anchors.files,["src/lib/menu.ts"]);
});

test("debug, implementation and verify plans use different channel order",()=>{
  assert.deepEqual(planQuery("Neden 502 upstream unreachable döner?").rounds[0].steps.map((item)=>item.channel),["exact-sql","graph-flow","fts"]);
  assert.deepEqual(planQuery("Yeni captcha formu eklemek için hangi pattern izlenmeli?").rounds[0].steps.map((item)=>item.channel),["fts","graph-flow","verification-graph"]);
  assert.deepEqual(planQuery("Hangi test ve lint komutları çalıştırılmalı?").rounds[0].steps.map((item)=>item.channel),["verification-graph","exact-sql"]);
});

test("automatically inferred memory types boost while explicit constraints filter",()=>{
  const inferred=planQuery("cache ve rendering davranışı nedir?");
  assert.equal(inferred.memoryTypeMode,"boost");
  assert.ok(inferred.memoryTypes.includes("cache"));
  const explicit=planQuery("davranış nedir?",{memoryTypes:["cache"]});
  assert.equal(explicit.memoryTypeMode,"filter");
  assert.deepEqual(explicit.memoryTypes,["cache"]);
});

test("opens round two only for measurable insufficiency",()=>{
  const plan=planQuery("GATEWAY_URL değişirse ne etkilenir?");
  assert.deepEqual(decideSecondRound(plan,{resultCount:4,evidenceCount:4,relationCoverage:1}),{run:false,triggers:[]});
  assert.deepEqual(decideSecondRound(plan,{resultCount:4,evidenceCount:2,relationCoverage:.5,unresolvedAnchors:["GATEWAY_URL"]}),
    {run:true,triggers:["unresolved-anchor","missing-relations"]});
});

test("keeps unknown intent bounded and records abstention conditions",()=>{
  const plan=planQuery("Ekip neden bu mimariyi seçti?");
  assert.equal(plan.intent,"unknown");
  assert.equal(plan.rounds[0].steps[0]?.required,false);
  assert.deepEqual(plan.rounds[0].steps.map((item)=>item.channel),["fts"]);
  assert.ok(plan.abstainWhen.some((item)=>item.includes("decision/why")));
});
