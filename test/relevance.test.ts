import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryType, SearchResult } from "../src/types.js";
import { rankAndDedupe } from "../src/retrieval/ranking.js";
import { queryTerms, relevanceScore } from "../src/retrieval/relevance.js";

function route(id:number,path:string,sqlRank:number):SearchResult {
  return {id,repository:"repo",type:"rendering" as MemoryType,subject:`route:${path}`,
    content:`Route ${path} uses app router (page), renders as dynamic-ssr.`,
    sourceFile:`src/app${path==="/" ? "" : path}/page.tsx`,commitSha:"sha",repositorySha:"sha",
    score:0,channels:["sql"],confidence:"verified",evidenceCount:1,locatedEvidenceCount:0,
    relationCoverage:1,channelRanks:{sql:sqlRank}};
}

test("the route the question names outranks the one that merely sorts first",()=>{
  const question="Kart sihirbazı ana sayfası hangi route ve source dosyasındadır?";
  // Channel ranks deliberately favour the wrong answer, as alphabetical SQL order did.
  const ranked=rankAndDedupe([route(1,"/",1),route(2,"/kart-sihirbazi",14),route(3,"/kredi-karti",13)],
    "lookup",10,queryTerms(question));
  assert.equal(ranked[0]?.subject,"route:/kart-sihirbazi");
  assert.ok((ranked[0]?.ranking?.features.queryRelevance ?? 0)>(ranked[1]?.ranking?.features.queryRelevance ?? 1));
});

test("without query terms the ranker keeps its previous ordering",()=>{
  const ranked=rankAndDedupe([route(1,"/",1),route(2,"/kart-sihirbazi",14)],"lookup");
  assert.equal(ranked[0]?.subject,"route:/");
  assert.equal(ranked[0]?.ranking?.features.queryRelevance,.5);
});

test("a strong channel hit on a duplicate survives the merge",()=>{
  const sql={...route(1,"/kart-sihirbazi",14)};
  const fts={...route(2,"/kart-sihirbazi",0),channels:["fts"],channelRanks:{fts:1}};
  const merged=rankAndDedupe([sql,fts],"lookup",10,queryTerms("kart sihirbazı"))[0]!;
  assert.deepEqual(merged.channelRanks,{sql:14,fts:1});
  assert.equal(merged.ranking?.features.channelRelevance,1);
});

test("identity matches count for more than prose, and Turkish suffixes still match",()=>{
  const terms=queryTerms("kart sihirbazı sayfasının dosyası");
  const identity=relevanceScore(terms,{subject:"route:/kart-sihirbazi",sourceFile:"src/app/kart-sihirbazi/page.tsx"});
  const prose=relevanceScore(terms,{subject:"route:/",content:"kart sihirbazi sayfa dosya"});
  assert.ok(identity>prose);
  // "sayfasının" must still match "sayfa": Turkish is agglutinative.
  assert.ok(relevanceScore(queryTerms("sayfasının"),{subject:"sayfa"})>0);
  // Question scaffolding carries no signal.
  assert.equal(queryTerms("hangi ve nedir bu").size,0);
});
