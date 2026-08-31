import type { MemoryType, SearchResult } from "../types.js";
import type { TaskIntent } from "./intent.js";

const WEIGHTS={taskFit:.25,relationCoverage:.25,freshness:.2,evidenceQuality:.15,entitySpecificity:.1,channelRelevance:.05} as const;

function clamp(value:number):number { return Math.max(0,Math.min(1,value)); }

function normalizedSubject(value:string):string {
  return value.trim().replace(/:\d+$/," ").trim().replace(/\s+/g," ");
}

/** Identity used for result dedupe; occurrences and channel hits never enter the key. */
export function canonicalEntityKey(result:SearchResult):string {
  const subject=normalizedSubject(result.subject);
  if (result.type==="configuration") return `${result.repository}:config:${subject.replace(/^config:/i,"")}`;
  if (result.type==="dependency"&&/^config:/i.test(subject)) return `${result.repository}:config:${subject.slice(7)}`;
  if (/^route:/i.test(subject)) return `${result.repository}:route:${subject.slice(6)}`;
  return `${result.repository}:${result.type}:${subject}`;
}

function taskFit(result:SearchResult,intent:TaskIntent):number {
  const {type,channels}=result;
  if (result.exactAnchorMatch) return 1;
  if (channels.includes("graph")) return clamp((["explain-flow","impact","debug","change-review"].includes(intent) ? 1 : .75)+(result.queryTypeBoost ?? 0));
  const preferred:Partial<Record<TaskIntent,MemoryType[]>>={
    lookup:["repository_profile","rendering","configuration","dependency","api_dependency","build","seo"],
    "explain-flow":["api_dependency","data_fetching","module_contract","cache","rendering","configuration"],
    impact:["module_contract","configuration","dependency","api_dependency","rendering","shared_package","design_system"],
    debug:["error_handling","module_contract","api_dependency","configuration","security","cache","rendering"],
    "implementation-plan":["module_contract","business_rule","api_dependency","rendering","cache","build","design_system"],
    "change-review":["technical_debt","rendering","api_dependency","configuration","build"],
    verify:["build","error_handling","technical_debt"],
    unknown:[],
  };
  const base=preferred[intent]?.includes(type) ? .8
    : intent==="unknown" ? .25
    : type==="business_capability"||type==="performance_observation" ? .3 : .55;
  return clamp(base+(result.queryTypeBoost ?? 0));
}

function freshness(result:SearchResult):number {
  if (!result.commitSha||!result.repositorySha) return .5;
  return result.commitSha===result.repositorySha ? 1 : .2;
}

function evidenceQuality(result:SearchResult):number {
  if (result.qualityScore!=null) return clamp(result.qualityScore);
  let score=result.confidence==="verified"||result.confidence==="observed" ? .55
    : result.confidence==="derived" ? .45 : result.confidence==="inferred" ? .25 : .35;
  if ((result.evidenceCount ?? 0)>0||result.sourceFile) score+=.2;
  if ((result.locatedEvidenceCount ?? 0)>0) score+=.2;
  // Environment declarations prove occurrence, not behavior (RCE-006 R4/R5).
  if (result.sourceFile&&/(?:^|\/)\.env(?:\.|$)/.test(result.sourceFile)) score-=.35;
  return clamp(score);
}

function entitySpecificity(result:SearchResult):number {
  const key=canonicalEntityKey(result);
  if (key.includes(":route:")||key.includes(":config:")||result.subject.includes("#")) return 1;
  if (/\.[cm]?[jt]sx?(?::\d+)?$/.test(result.subject)) return .8;
  return .6;
}

function channelRelevance(result:SearchResult):number {
  const ranks=Object.values(result.channelRanks ?? {}).filter((rank):rank is number=>rank!=null&&rank>0);
  if (!ranks.length) return .5;
  return 1/Math.min(...ranks);
}

function features(result:SearchResult,intent:TaskIntent):NonNullable<SearchResult["ranking"]>["features"] {
  return {
    taskFit:taskFit(result,intent),
    relationCoverage:clamp(result.relationCoverage ?? (result.channels.includes("graph") ? .8 : .2)),
    freshness:freshness(result),
    evidenceQuality:evidenceQuality(result),
    entitySpecificity:entitySpecificity(result),
    channelRelevance:channelRelevance(result),
  };
}

function weightedScore(value:ReturnType<typeof features>):number {
  return Object.entries(WEIGHTS).reduce((sum,[name,weight])=>sum+value[name as keyof typeof value]*weight,0);
}

function mergeGroup(group:SearchResult[],intent:TaskIntent):SearchResult {
  const ranked=group.map((item)=>{
    const itemFeatures=features(item,intent);
    return {...item,canonicalEntity:canonicalEntityKey(item),ranking:{score:weightedScore(itemFeatures),features:itemFeatures}};
  }).sort((a,b)=>b.ranking.score-a.ranking.score||a.id-b.id);
  const primary=ranked[0]!;
  const channels=[...new Set(ranked.flatMap((item)=>item.channels))];
  const sourceFiles=[...new Set(ranked.flatMap((item)=>item.sourceFiles ?? (item.sourceFile ? [item.sourceFile] : [])))];
  const duplicateIds=ranked.slice(1).map((item)=>item.id);
  return {...primary,score:primary.ranking.score,channels,sourceFiles,duplicateIds};
}

/** Rank canonical entities with explicit features; channel scores are never added together. */
export function rankAndDedupe(results:SearchResult[],intent:TaskIntent,limit=10):SearchResult[] {
  const groups=new Map<string,SearchResult[]>();
  for (const result of results) {
    const key=canonicalEntityKey(result);
    const bucket=groups.get(key);
    if (bucket) bucket.push(result); else groups.set(key,[result]);
  }
  return [...groups.values()].map((group)=>mergeGroup(group,intent))
    .sort((a,b)=>(b.ranking?.score ?? 0)-(a.ranking?.score ?? 0)||a.canonicalEntity!.localeCompare(b.canonicalEntity!))
    .slice(0,Math.max(1,limit));
}
