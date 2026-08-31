import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryType, SearchResult } from "../src/types.js";
import { canonicalEntityKey, rankAndDedupe } from "../src/retrieval/ranking.js";

function candidate(id:number,subject:string,overrides:Partial<SearchResult>={}):SearchResult {
  return {id,repository:"repo",type:"configuration" as MemoryType,subject,content:subject,sourceFile:"src/config.ts",commitSha:"sha",repositorySha:"sha",score:99,channels:["fts"],confidence:"verified",evidenceCount:1,locatedEvidenceCount:1,channelRanks:{fts:id},...overrides};
}

test("dedupes config memories by canonical entity and merges provenance",()=>{
  const result=rankAndDedupe([
    candidate(1,"GATEWAY_URL",{sourceFile:"src/a.ts",channels:["fts"]}),
    candidate(2,"config:GATEWAY_URL",{type:"dependency",sourceFile:"src/b.ts",channels:["vector"]}),
  ],"impact");
  assert.equal(result.length,1);
  assert.equal(result[0]?.canonicalEntity,"repo:config:GATEWAY_URL");
  assert.deepEqual(result[0]?.channels.sort(),["fts","vector"]);
  assert.deepEqual(result[0]?.sourceFiles.sort(),["src/a.ts","src/b.ts"]);
  assert.equal(result[0]?.duplicateIds?.length,1);
});

test("relation coverage outranks multi-channel score accumulation",()=>{
  const broad=candidate(1,"BROAD",{channels:["fts","vector","sql"],channelRanks:{fts:1,vector:1,sql:1},relationCoverage:.1});
  const related=candidate(2,"RELATED",{channels:["graph"],channelRanks:{graph:3},relationCoverage:1});
  const result=rankAndDedupe([broad,related],"impact");
  assert.equal(result[0]?.subject,"RELATED");
  assert.ok((result[0]?.score ?? 0)<1,"scores are normalized features, not summed channel scores");
});

test("fresh evidence outranks stale evidence when other features match",()=>{
  const stale=candidate(1,"STALE",{commitSha:"old"});
  const fresh=candidate(2,"FRESH");
  assert.equal(rankAndDedupe([stale,fresh],"lookup")[0]?.subject,"FRESH");
});

test("located verified evidence outranks unsupported inferred content",()=>{
  const weak=candidate(1,"WEAK",{confidence:"inferred",sourceFile:null,evidenceCount:0,locatedEvidenceCount:0});
  const strong=candidate(2,"STRONG",{confidence:"verified",locatedEvidenceCount:1});
  assert.equal(rankAndDedupe([weak,strong],"lookup")[0]?.subject,"STRONG");
  const environment=candidate(3,"ENV",{sourceFile:".env.production",channelRanks:{fts:1}});
  const source=candidate(4,"SOURCE",{sourceFile:"src/config.ts",channelRanks:{fts:2}});
  assert.equal(rankAndDedupe([environment,source],"lookup")[0]?.subject,"SOURCE");
});

test("task fit changes ordering across intents",()=>{
  const build=candidate(1,"package.json",{type:"build"});
  const api=candidate(2,"POST /thing",{type:"api_dependency"});
  assert.equal(rankAndDedupe([build,api],"verify")[0]?.type,"build");
  assert.equal(rankAndDedupe([build,api],"explain-flow")[0]?.type,"api_dependency");
  const exact=candidate(3,"EXACT",{exactAnchorMatch:true,type:"technical_debt"});
  assert.equal(rankAndDedupe([api,exact],"impact")[0]?.subject,"EXACT");
});

test("ranking is deterministic when feature scores tie",()=>{
  const a=candidate(20,"A",{channelRanks:{fts:1}});
  const b=candidate(10,"B",{channelRanks:{fts:1}});
  assert.deepEqual(rankAndDedupe([a,b],"lookup").map((item)=>item.subject),["A","B"]);
  assert.equal(canonicalEntityKey(a),"repo:config:A");
});
