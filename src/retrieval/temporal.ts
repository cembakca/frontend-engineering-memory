import type { GraphEdge } from "../analyzers/symbol-graph.js";
import type { MemoryStore } from "../memory/store.js";
import { createAnswerContract } from "./answer-contract.js";

export interface SnapshotRoute {
  route:string;routeType:string;sourceFile:string;rendering:string;authRequired:boolean|null;middlewareMatched:boolean|null;
  cache:string[];dataSources:string[];backendDependencies:string[];seoType:string;metadataSource:string|null;
}
export interface SnapshotMemory { type:string;subject:string;content:string;confidence:string;evidence:string[] }
export interface RepositorySnapshot {
  repository:string;sha:string;profile:Record<string,unknown>;routes:SnapshotRoute[];
  dependencies:Array<{type:string;name:string;sourceFile:string|null;configKey:string|null}>;
  memories:SnapshotMemory[];graph:GraphEdge[];createdAt?:string;
}

function key(edge:GraphEdge):string { return `${edge.type}\0${edge.from}\0${edge.to}`; }
function routeKey(route:SnapshotRoute):string { return `${route.route}\0${route.sourceFile}`; }
function memoryKey(memory:SnapshotMemory):string { return `${memory.type}\0${memory.subject}`; }
function terms(value:string):string[] { return value.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? []; }
function changedFields(before:Record<string,unknown>,after:Record<string,unknown>,fields:string[]):Record<string,{from:unknown;to:unknown}> {
  const out:Record<string,{from:unknown;to:unknown}>={};
  for (const field of fields) if (JSON.stringify(before[field])!==JSON.stringify(after[field])) out[field]={from:before[field],to:after[field]};
  return out;
}

export function diffBehaviorSnapshots(from:RepositorySnapshot,to:RepositorySnapshot,maxChars=10_000):any {
  const fromRoutes=new Map(from.routes.map((item)=>[routeKey(item),item]));
  const toRoutes=new Map(to.routes.map((item)=>[routeKey(item),item]));
  const routeChanges:any[]=[];
  for (const [id,route] of toRoutes) {
    const previous=fromRoutes.get(id);
    if (!previous) routeChanges.push({change:"added",route:route.route,sourceFile:route.sourceFile,after:route});
    else {
      const fields=changedFields(previous as any,route as any,["rendering","authRequired","middlewareMatched","cache","dataSources","backendDependencies","seoType","metadataSource"]);
      if (Object.keys(fields).length) routeChanges.push({change:"changed",route:route.route,sourceFile:route.sourceFile,fields});
    }
  }
  for (const [id,route] of fromRoutes) if (!toRoutes.has(id)) routeChanges.push({change:"removed",route:route.route,sourceFile:route.sourceFile,before:route});

  const relationTypes=new Set(["calls","renders","reads","fetches","submits-to","references","delegates-to"]);
  const fromEdges=new Map(from.graph.filter((item)=>relationTypes.has(item.type)).map((item)=>[key(item),item]));
  const toEdges=new Map(to.graph.filter((item)=>relationTypes.has(item.type)).map((item)=>[key(item),item]));
  const flowChanges:any[]=[];
  for (const [id,edge] of toEdges) if (!fromEdges.has(id)) flowChanges.push({change:"added",relation:edge.type,from:edge.from,to:edge.to,evidence:{file:edge.filePath,line:edge.startLine,symbol:edge.symbol,confidence:edge.confidence}});
  for (const [id,edge] of fromEdges) if (!toEdges.has(id)) flowChanges.push({change:"removed",relation:edge.type,from:edge.from,to:edge.to,evidence:{file:edge.filePath,line:edge.startLine,symbol:edge.symbol,confidence:edge.confidence}});

  const groupTargets=(snapshot:RepositorySnapshot,type:"reads"|"fetches")=>{
    const out=new Map<string,string[]>();
    for (const edge of snapshot.graph.filter((item)=>item.type===type)) out.set(edge.to,[...new Set([...(out.get(edge.to) ?? []),edge.from])].sort());
    return out;
  };
  const targetDiff=(type:"reads"|"fetches")=>{
    const before=groupTargets(from,type); const after=groupTargets(to,type); const out:any[]=[];
    for (const target of new Set([...before.keys(),...after.keys()])) {
      const left=before.get(target) ?? []; const right=after.get(target) ?? [];
      if (JSON.stringify(left)!==JSON.stringify(right)) out.push({target,before:left,after:right});
    }
    return out;
  };

  const fromMemories=new Map(from.memories.map((item)=>[memoryKey(item),item]));
  const toMemories=new Map(to.memories.map((item)=>[memoryKey(item),item]));
  const factChanges:any[]=[];
  for (const [id,item] of toMemories) {
    const previous=fromMemories.get(id);
    if (!previous) factChanges.push({change:"added",type:item.type,subject:item.subject,after:item.content,evidence:item.evidence});
    else if (previous.content!==item.content) factChanges.push({change:"changed",type:item.type,subject:item.subject,before:previous.content,after:item.content,evidence:item.evidence});
  }
  for (const [id,item] of fromMemories) if (!toMemories.has(id)) factChanges.push({change:"removed",type:item.type,subject:item.subject,before:item.content,evidence:item.evidence});

  const pack:any={schemaVersion:"1.0",kind:"behavior-diff",repository:to.repository,fromSha:from.sha,toSha:to.sha,
    routeChanges,flowChanges,configChanges:targetDiff("reads"),apiChanges:targetDiff("fetches"),factChanges,
    answerContract:createAnswerContract({derivedRelations:["routeChanges","flowChanges","configChanges","apiChanges","factChanges"],
      empty:!routeChanges.length&&!flowChanges.length&&!factChanges.length}),budget:{maxChars,usedChars:0,estimatedTokens:0,truncated:false,omitted:{}}};
  const sections=["factChanges","flowChanges","apiChanges","configChanges","routeChanges"];
  while (JSON.stringify(pack).length>maxChars) {
    const section=sections.find((name)=>(pack[name] as any[]).length);
    if (!section) break;
    (pack[section] as any[]).pop(); pack.budget.truncated=true;
    pack.budget.omitted[section]=(pack.budget.omitted[section] ?? 0)+1;
    pack.answerContract=createAnswerContract({derivedRelations:["routeChanges","flowChanges","configChanges","apiChanges","factChanges"],truncated:true});
  }
  for (let index=0;index<3;index+=1) { pack.budget.usedChars=JSON.stringify(pack).length; pack.budget.estimatedTokens=Math.ceil(pack.budget.usedChars/3.5); }
  return pack;
}

export class TemporalContextEngine {
  constructor(private readonly store:MemoryStore) {}
  behaviorDiff(repository:string,fromSha:string,toSha:string,maxChars=10_000):any {
    const from=this.store.getRepositorySnapshot(repository,fromSha) as RepositorySnapshot|undefined;
    const to=this.store.getRepositorySnapshot(repository,toSha) as RepositorySnapshot|undefined;
    if (!from||!to) throw new Error(`Indexed snapshots required for behavior diff: ${fromSha}..${toSha}`);
    return diffBehaviorSnapshots(from,to,maxChars);
  }
  contextAtSha(repository:string,sha:string,question:string,maxChars=8_000):any {
    const snapshot=this.store.getRepositorySnapshot(repository,sha) as RepositorySnapshot|undefined;
    if (!snapshot) throw new Error(`Indexed snapshot not found: ${repository}@${sha}`);
    const query=new Set(terms(question));
    const score=(value:string)=>terms(value).filter((term)=>query.has(term)).length;
    const facts=snapshot.memories.map((item)=>({item,score:score(`${item.type} ${item.subject} ${item.content}`)})).filter((row)=>row.score>0).sort((a,b)=>b.score-a.score).slice(0,10).map((row)=>row.item);
    const relations=snapshot.graph.map((item)=>({item,score:score(`${item.type} ${item.from} ${item.to}`)})).filter((row)=>row.score>0).sort((a,b)=>b.score-a.score).slice(0,30).map((row)=>row.item);
    const sourceFallback=[...new Set([...facts.flatMap((item)=>item.evidence),...relations.map((item)=>item.filePath)])];
    const pack:any={schemaVersion:"1.0",kind:"point-in-time",repository,query:question,snapshotSha:sha,facts,relations,
      answerContract:createAnswerContract({}),
      budget:{maxChars,usedChars:0,estimatedTokens:0,truncated:false,omitted:{}}};
    const rebuild=()=>{ pack.answerContract=createAnswerContract({facts:facts.length ? ["facts"] : [],derivedRelations:relations.length ? ["relations"] : [],
      sourceFallback,empty:!facts.length&&!relations.length,uncertainty:!facts.length&&!relations.length ? ["no matching fact or relation in indexed snapshot"] : [],
      truncated:pack.budget.truncated}); };
    rebuild();
    while (JSON.stringify(pack).length>maxChars&&(relations.length||facts.length||sourceFallback.length)) {
      let section="sourceFallback";
      if (sourceFallback.length) sourceFallback.pop(); else if (relations.length) { relations.pop(); section="relations"; } else { facts.pop(); section="facts"; }
      pack.budget.truncated=true; pack.budget.omitted[section]=(pack.budget.omitted[section] ?? 0)+1; rebuild();
    }
    for (let index=0;index<3;index+=1) { pack.budget.usedChars=JSON.stringify(pack).length; pack.budget.estimatedTokens=Math.ceil(pack.budget.usedChars/3.5); }
    return pack;
  }
}
