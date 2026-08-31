import type { MemoryDatabase } from "../memory/database.js";
import { MemoryStore } from "../memory/store.js";
import type { MemoryType } from "../types.js";
import { buildAgentContext } from "../retrieval/context.js";

function json(value:string | null | undefined,fallback:any):any {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function compactRoute(row:any):any {
  return {
    route:row.route,type:row.route_type,router:row.router_type,sourceFile:row.source_file,
    rendering:row.rendering_mode,dynamic:Boolean(row.dynamic_route),params:json(row.route_params_json,[]),
    serverComponent:row.server_component==null ? null : Boolean(row.server_component),
    authRequired:row.auth_required==null ? null : Boolean(row.auth_required),
    middlewareMatched:row.middleware_matched==null ? null : Boolean(row.middleware_matched),
    lastSeenSha:row.last_seen_sha,
  };
}

export class MemoryTools {
  private readonly store:MemoryStore;
  constructor(private readonly memoryDb:MemoryDatabase) { this.store=new MemoryStore(memoryDb); }

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

  quality(repository?:string):any { return this.store.qualityReport(repository); }
}
