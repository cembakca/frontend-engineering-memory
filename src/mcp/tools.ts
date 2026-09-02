import type { MemoryDatabase } from "../memory/database.js";
import { MemoryStore } from "../memory/store.js";
import type { MemoryType } from "../types.js";
import { buildAgentContext } from "../retrieval/context.js";
import { TaskContextCompiler } from "../retrieval/task-context.js";
import { FreshnessCache, packFreshness } from "../retrieval/freshness.js";
import { planQuery } from "../retrieval/query-plan.js";
import { RetrievalTelemetry } from "../telemetry/retrieval-telemetry.js";
import { routeLookupKey } from "../retrieval/route-identity.js";
import { matchingAliasRoute, normalizeQueryAliases } from "../retrieval/query-vocabulary.js";

function json(value:string | null | undefined,fallback:any):any {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function compactRoute(row:any):any {
  return {
    ...(row.repository ? {repository:row.repository} : {}),
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

export type RouteDetail="summary"|"runtime"|"dependencies"|"full";

function routeEvidence(row:any):string[] {
  const source=String(row.source_file);
  return json(row.evidence_json,[]).filter((item:unknown)=>String(item).startsWith(`${source}:`)).slice(0,8);
}

function budgetRoutePayload(payload:any,maxChars:number):any {
  const bounded=Math.max(500,Math.min(24_000,maxChars));
  const omitted:Record<string,number>={};
  const budget={maxChars:bounded,usedChars:0,estimatedTokens:0,truncated:false,omitted};
  payload.budget=budget;
  const arrays:Array<{name:string;value:any[]}>=[];
  const add=(name:string,value:unknown)=>{ if (Array.isArray(value)) arrays.push({name,value}); };
  add("dependencies.inherited",payload.dependencyScope?.inherited);
  add("dependencies.direct",payload.dependencyScope?.direct);
  add("clientBoundaries",payload.clientBoundaries);
  add("evidence",payload.evidence);
  add("renderingEvidence",payload.renderingEvidence);
  add("middlewareMatchers",payload.middlewareMatchers);
  add("layoutChain",payload.layoutChain);
  add("matches",payload.matches);
  add("routes",payload.routes);
  const trimArray=():boolean=>{
    const candidate=arrays.filter((item)=>item.value.length)
      .sort((a,b)=>JSON.stringify(b.value[b.value.length-1]).length-JSON.stringify(a.value[a.value.length-1]).length)[0];
    if (!candidate) return false;
    candidate.value.pop();
    omitted[candidate.name]=(omitted[candidate.name] ?? 0)+1;
    budget.truncated=true;
    return true;
  };
  const optionalSections=["evidence","clientBoundaries","dependencyScope","dependencyCounts","dataSources","backendDependencies",
    "middlewareMatchers","layoutChain","cacheBehavior","seoType","metadataSource","segmentConfig","controlFlow"];
  for (let guard=0;guard<500;guard+=1) {
    budget.usedChars=JSON.stringify(payload).length;
    budget.estimatedTokens=Math.ceil(budget.usedChars/3.5);
    const serializedLength=JSON.stringify(payload).length;
    if (serializedLength<=bounded) {
      if (budget.usedChars===serializedLength) break;
      continue;
    }
    if (trimArray()) continue;
    const key=optionalSections.find((name)=>payload[name]!==undefined);
    if (!key) break; // The deliberately small core summary is all that remains.
    const value=payload[key];
    delete payload[key];
    omitted[key]=Array.isArray(value) ? value.length : 1;
    budget.truncated=true;
  }
  return payload;
}

/** Stable identifiers a pack returned, so a retrieval miss can be traced without storing any content. */
function packResultIds(pack:any):string[] {
  const ids:string[]=[];
  // A structured route answer is a result; without this the telemetry recorded
  // a correct route lookup as an abstention.
  if (pack?.route?.route) ids.push(`route:${pack.route.route}`);
  if (Array.isArray(pack?.relatedRoutes)) ids.push(...pack.relatedRoutes.map((row:any)=>`route:${row.route}`));
  if (Array.isArray(pack?.items)) ids.push(...pack.items.map((item:any)=>`${item.type}:${item.subject}`));
  if (Array.isArray(pack?.steps)) ids.push(...pack.steps.map((step:any)=>String(step.to ?? step.affected ?? "")));
  if (Array.isArray(pack?.relations)) ids.push(...pack.relations.map((row:any)=>String(row.affected ?? row.packageName ?? row.providerRepository ?? "")));
  if (Array.isArray(pack?.changes)) ids.push(...pack.changes.map((row:any)=>String(row.entity ?? "")));
  if (Array.isArray(pack?.facts)) ids.push(...pack.facts.map((row:any)=>String(row.subject ?? "")));
  if (Array.isArray(pack?.exemplars)) ids.push(...pack.exemplars.map((row:any)=>String(row.entity ?? row.subject ?? "")));
  for (const values of Object.values(pack?.affected ?? {})) if (Array.isArray(values)) ids.push(...values.map(String));
  if (Array.isArray(pack?.verification?.commands)) ids.push(...pack.verification.commands.map((row:any)=>`verify:${row.name}`));
  if (Array.isArray(pack?.verification?.tests)) ids.push(...pack.verification.tests.map((row:any)=>`test:${row.key}`));
  return ids.filter(Boolean);
}

/** `,"telemetryEventId":<id>` — annotation the tool adds to a finished pack. */
const TELEMETRY_ANNOTATION_CHARS=48;

function packResultCount(pack:any):number {
  return packResultIds(pack).length;
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

  repositories():any { return {repositories:this.store.listRepositories().map((row:any)=>({name:row.name,packageName:row.package_name,nextVersion:row.next_version,reactVersion:row.react_version,router:row.router_type,lastIndexedSha:row.last_indexed_sha,lastIndexedAt:row.last_indexed_at})),repositoryLinks:this.store.listRepositoryLinks()}; }

  repository(name:string):any {
    const row=this.store.getRepository(name);
    if (!row) throw new Error(`Repository not found: ${name}`);
    const links=this.store.listRepositoryLinks(name);
    return {name:row.name,path:row.path,packageName:row.package_name,framework:row.framework,nextVersion:row.next_version,reactVersion:row.react_version,nodeVersion:row.node_version,router:row.router_type,packageManager:row.package_manager,outputMode:row.output_mode,
      repositoryDependencies:links.filter((link:any)=>link.direction==="outgoing"),repositoryConsumers:links.filter((link:any)=>link.direction==="incoming"),
      lastIndexedSha:row.last_indexed_sha,lastIndexedAt:row.last_indexed_at};
  }

  routes(repository:string|undefined,limit=50,maxChars=8_000):any {
    return budgetRoutePayload({repository:repository ?? null,
      routes:this.store.listRoutes(repository).slice(0,Math.max(1,Math.min(100,limit))).map(compactRoute)},maxChars);
  }

  private routeDetail(row:any,detail:RouteDetail="summary",maxChars=8_000):any {
    const repository=String(row.repository);
    const actualRoute=String(row.route);
    const compact=compactRoute(row);
    const summary:any={repository,route:compact.route,type:compact.type,router:compact.router,sourceFile:compact.sourceFile,
      rendering:compact.rendering,renderingBasis:compact.renderingBasis,serverComponent:compact.serverComponent,
      lastSeenSha:compact.lastSeenSha,detail,controlFlow:compact.controlFlow,renderingEvidence:routeEvidence(row)};
    if (detail==="summary") return budgetRoutePayload(summary,maxChars);

    const runtime={...summary,segmentConfig:compact.segmentConfig,dynamic:compact.dynamic,params:compact.params,
      authRequired:compact.authRequired,middlewareMatched:compact.middlewareMatched,
      layoutChain:json(row.layout_chain_json,[]),cacheBehavior:json(row.cache_behavior_json,[]),
      seoType:row.seo_type,metadataSource:row.metadata_source,middlewareMatchers:json(row.middleware_matchers_json,[])};
    if (detail==="runtime") return budgetRoutePayload(runtime,maxChars);

    const dependencies=this.store.listRouteDependencies(repository,actualRoute);
    const dependencyScope={
      direct:dependencies.filter((item:any)=>item.source_file===row.source_file),
      inherited:dependencies.filter((item:any)=>item.source_file!==row.source_file),
    };
    const dependencyPayload={...summary,dependencyScope,
      dependencyCounts:{direct:dependencyScope.direct.length,inherited:dependencyScope.inherited.length,total:dependencies.length}};
    if (detail==="dependencies") return budgetRoutePayload(dependencyPayload,maxChars);

    return budgetRoutePayload({...runtime,...dependencyPayload,
      clientBoundaries:json(row.client_boundaries_json,[]),dataSources:json(row.data_sources_json,[]),
      backendDependencies:json(row.backend_dependencies_json,[]),evidence:json(row.evidence_json,[])},maxChars);
  }

  route(repository:string|undefined,route:string,options:{detail?:RouteDetail;maxChars?:number}={}):any {
    let resolvedRoute=route;
    if (!route.startsWith("/")) {
      const repositories=repository ? [this.store.getRepository(repository)].filter(Boolean) : this.store.listRepositories();
      const resolved=repositories.flatMap((repo:any)=>{
        let aliases={};
        try { aliases=normalizeQueryAliases(JSON.parse(String(repo.query_aliases_json ?? "{}"))); } catch {}
        const candidate=matchingAliasRoute(route,[aliases],this.store.listRoutes(String(repo.name)).map((item:any)=>String(item.route)));
        return candidate ? [{repository:String(repo.name),route:candidate}] : [];
      });
      if (!resolved.length) throw new Error(`Active route could not be resolved from query: ${repository ?? "all repositories"} ${route}`);
      if (repository) resolvedRoute=resolved[0]!.route;
      else {
        const detail=options.detail ?? "summary";
        const maxChars=options.maxChars ?? 8_000;
        const matches=resolved.flatMap((item)=>this.store.findRoutes(item.route,item.repository));
        return budgetRoutePayload({queryRoute:route,resolvedRoutes:resolved,
          matches:matches.map((row)=>this.routeDetail(row,detail,maxChars))},maxChars);
      }
    }
    const matches=this.store.findRoutes(resolvedRoute,repository);
    if (!matches.length) throw new Error(`Active route not found: ${repository ?? "all repositories"} ${route}`);
    const detail=options.detail ?? "summary";
    const maxChars=options.maxChars ?? 8_000;
    if (repository) return this.routeDetail(matches[0],detail,maxChars);
    return budgetRoutePayload({queryRoute:route,normalizedRoute:routeLookupKey(resolvedRoute),
      matches:matches.map((row)=>this.routeDetail(row,detail,maxChars))},maxChars);
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
        {...options,reserveChars:TELEMETRY_ANNOTATION_CHARS,...(freshness ? {freshness:packFreshness(freshness)} : {})});
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
