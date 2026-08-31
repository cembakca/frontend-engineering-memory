import type { MemoryDatabase } from "../memory/database.js";
import { MemoryStore } from "../memory/store.js";
import type { MemoryType } from "../types.js";
import { buildAgentContext } from "../retrieval/context.js";
import { TaskContextCompiler } from "../retrieval/task-context.js";
import { FreshnessCache, packFreshness } from "../retrieval/freshness.js";
import { planQuery } from "../retrieval/query-plan.js";
import { RetrievalTelemetry } from "../telemetry/retrieval-telemetry.js";

function json(value:string | null | undefined,fallback:any):any {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function compactRoute(row:any):any {
  return {
    route:row.route,type:row.route_type,router:row.router_type,sourceFile:row.source_file,
    rendering:row.rendering_mode,
    // RCE-008: how the classification was reached, and whether the route redirects at all.
    renderingBasis:row.rendering_basis ?? "observed",
    segmentConfig:json(row.segment_config_json,{}),
    controlFlow:json(row.control_flow_json,[]),
    dynamic:Boolean(row.dynamic_route),params:json(row.route_params_json,[]),
    serverComponent:row.server_component==null ? null : Boolean(row.server_component),
    authRequired:row.auth_required==null ? null : Boolean(row.auth_required),
    middlewareMatched:row.middleware_matched==null ? null : Boolean(row.middleware_matched),
    lastSeenSha:row.last_seen_sha,
  };
}

/** Stable identifiers a pack returned, so a retrieval miss can be traced without storing any content. */
function packResultIds(pack:any):string[] {
  if (Array.isArray(pack?.items)) return pack.items.map((item:any)=>`${item.type}:${item.subject}`);
  if (Array.isArray(pack?.steps)) return pack.steps.map((step:any)=>String(step.to ?? step.affected ?? ""));
  if (Array.isArray(pack?.relations)) return pack.relations.map((row:any)=>String(row.affected ?? ""));
  if (Array.isArray(pack?.changes)) return pack.changes.map((row:any)=>String(row.entity ?? ""));
  if (Array.isArray(pack?.facts)) return pack.facts.map((row:any)=>String(row.subject ?? ""));
  return [];
}

function packResultCount(pack:any):number {
  for (const key of ["items","steps","relations","changes","facts","exemplars"]) {
    if (Array.isArray(pack?.[key])) return pack[key].length;
  }
  return 0;
}

export class MemoryTools {
  private readonly store:MemoryStore;
  private readonly compiler:TaskContextCompiler;
  readonly telemetry:RetrievalTelemetry;
  private readonly freshness:FreshnessCache;
  constructor(private readonly memoryDb:MemoryDatabase) {
    this.store=new MemoryStore(memoryDb);
    this.compiler=new TaskContextCompiler(memoryDb);
    this.telemetry=new RetrievalTelemetry(memoryDb);
    this.freshness=new FreshnessCache(memoryDb);
  }

  repositories():any { return {repositories:this.store.listRepositories().map((row:any)=>({name:row.name,nextVersion:row.next_version,reactVersion:row.react_version,router:row.router_type,lastIndexedSha:row.last_indexed_sha,lastIndexedAt:row.last_indexed_at}))}; }

  repository(name:string):any {
    const row=this.store.getRepository(name);
    if (!row) throw new Error(`Repository not found: ${name}`);
    return {name:row.name,path:row.path,framework:row.framework,nextVersion:row.next_version,reactVersion:row.react_version,nodeVersion:row.node_version,router:row.router_type,packageManager:row.package_manager,outputMode:row.output_mode,lastIndexedSha:row.last_indexed_sha,lastIndexedAt:row.last_indexed_at};
  }

  routes(repository:string,limit=50):any { return {repository,routes:this.store.listRoutes(repository).slice(0,Math.max(1,Math.min(100,limit))).map(compactRoute)}; }

  route(repository:string,route:string):any {
    const row=this.store.getRoute(repository,route);
    if (!row) throw new Error(`Active route not found: ${repository} ${route}`);
    return {
      repository,...compactRoute(row),layoutChain:json(row.layout_chain_json,[]),clientBoundaries:json(row.client_boundaries_json,[]),
      dataSources:json(row.data_sources_json,[]),backendDependencies:json(row.backend_dependencies_json,[]),cacheBehavior:json(row.cache_behavior_json,[]),
      seoType:row.seo_type,metadataSource:row.metadata_source,middlewareMatchers:json(row.middleware_matchers_json,[]),
      evidence:json(row.evidence_json,[]),dependencies:this.store.listRouteDependencies(repository,route),
    };
  }

  dependencies(repository:string,options:{route?:string;type?:string;limit?:number}={}):any {
    const limit=Math.max(1,Math.min(100,options.limit ?? 30));
    const rows=options.route ? this.store.listRouteDependencies(repository,options.route) : this.store.listDependencies(repository);
    return {repository,route:options.route ?? null,dependencies:rows.filter((row:any)=>!options.type || (row.dependency_type ?? row.dependencyType)===options.type).slice(0,limit)};
  }

  changes(repository:string,since:string,limit=50,maxChars=10000):any {
    const selected:any[]=[];
    for (const row of this.store.listMemoryChanges(repository,since).slice(0,Math.max(1,Math.min(200,limit)))) {
      const compact={operation:row.operation,memoryId:row.memory_id,type:row.memory_type,subject:row.subject,fact:row.content,sourceFile:row.source_file,fromSha:row.from_sha,toSha:row.to_sha};
      if (JSON.stringify({repository,since,changes:[...selected,compact]}).length>maxChars && selected.length) break;
      selected.push(compact);
    }
    return {repository,since,changes:selected,estimatedTokens:Math.ceil(JSON.stringify(selected).length/3.5)};
  }

  search(query:string,options:{repository?:string;types?:MemoryType[];limit?:number;maxChars?:number}={}):Promise<any> {
    return buildAgentContext(this.memoryDb,query,{repository:options.repository,memoryTypes:options.types,limit:options.limit,maxChars:options.maxChars});
  }

  explain(question:string,options:{repository?:string;limit?:number;maxChars?:number}={}):Promise<any> {
    return this.search(question,{...options,limit:options.limit ?? 5,maxChars:options.maxChars ?? 8000});
  }

  async context(question:string,options:{repository:string;types?:MemoryType[];maxChars?:number;since?:string;atSha?:string;compareToSha?:string}):Promise<any> {
    const started=Date.now();
    // Planned separately for telemetry so the recorded intent keeps distinctions the
    // pack kind collapses: implementation-plan and verify both compile to `implementation`.
    const plan=planQuery(question,{repo:options.repository,memoryTypes:options.types});
    const channels=[...new Set(plan.rounds.flatMap((round)=>round.steps.map((step)=>step.channel)))];
    try {
      // RCE-026: no pack may omit its freshness state. An indexed SHA equal to
      // HEAD is not the same as current when the working tree is dirty. It is
      // passed into the compiler so the pack budgets it like any other content;
      // appending it afterwards would push the pack past the maxChars it declares.
      const freshness=await this.freshness.get(options.repository);
      const pack=await this.compiler.compile(question,
        freshness ? {...options,freshness:packFreshness(freshness)} : options);
      const serialized=JSON.stringify(pack);
      const uncertainty:string[]=pack?.answerContract?.uncertainty?.reasons ?? [];
      const fallback=(pack?.answerContract?.sourceFallback?.length ?? 0)>0 ? "targeted-source" as const
        : packResultCount(pack)===0 ? "abstain" as const : "none" as const;
      const eventId=this.telemetry.record({
        repository:options.repository,tool:"memory_context",query:question,
        intent:plan.intent,packKind:pack?.kind ?? null,snapshotSha:pack?.snapshotSha ?? null,channels,
        resultIds:packResultIds(pack),resultCount:packResultCount(pack),
        payloadChars:serialized.length,
        estimatedTokens:pack?.budget?.estimatedTokens ?? pack?.estimatedTokens ?? Math.ceil(serialized.length/3.5),
        latencyMs:Date.now()-started,fallback,gaps:uncertainty,
      });
      // Lets a later feedback report point at exactly this retrieval (RCE-025).
      return eventId!=null&&pack&&typeof pack==="object" ? {...pack,telemetryEventId:eventId} : pack;
    } catch (error) {
      this.telemetry.record({repository:options.repository,tool:"memory_context",query:question,
        intent:plan.intent,channels,latencyMs:Date.now()-started,error:(error as Error).message});
      throw error;
    }
  }

  quality(repository?:string):any { return this.store.qualityReport(repository); }
}
