import type { GraphEdge } from "../analyzers/symbol-graph.js";
import { extractSymbolGraph } from "../analyzers/symbol-graph.js";
import { extractVerificationGraph } from "../analyzers/verification-graph.js";
import type { MemoryDatabase } from "../memory/database.js";
import { MemoryStore } from "../memory/store.js";
import type { MemoryType } from "../types.js";
import { walkFiles } from "../utils/walk.js";
import { compileContextPack } from "./context-pack.js";
import { buildAgentContext } from "./context.js";
import { routeEntriesFrom, traceFlow } from "./flow.js";
import { traceImpact, type ImpactRoute } from "./impact.js";
import { planQuery } from "./query-plan.js";
import { hybridSearch } from "./search.js";
import { TemporalContextEngine } from "./temporal.js";
import { buildDecisionContext, isDecisionQuestion } from "./decision-context.js";

interface SemanticSnapshot {
  edges:GraphEdge[];
  routes:ImpactRoute[];
  files:string[];
  repoPath:string;
}

function terms(value:string):string[] {
  return value.toLocaleLowerCase("tr-TR").normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
    .match(/[a-z0-9_\[\]-]{3,}/g) ?? [];
}

function isRepositoryStrategyQuestion(question:string):boolean {
  const repositoryScope=/\b(project|proje(?:nin|de|yi)?|repository|repo)\b/i.test(question);
  const strategyScope=/\b(strategy|strateji(?:si)?|testing|test|error[- ]handling|hata yönetimi)\b/i.test(question);
  return repositoryScope&&strategyScope;
}

/**
 * Outgoing behavioural edges by node, so seed scoring can look at what a
 * candidate actually reaches. `exports` is excluded on purpose: it would give a
 * bare file an out-degree that no traversal follows, and the seed would resolve
 * to a node that produces an empty pack.
 */
function outgoingIndex(edges:GraphEdge[]):Map<string,GraphEdge[]> {
  const out=new Map<string,GraphEdge[]>();
  for (const edge of edges) {
    if (edge.type==="exports") continue;
    const bucket=out.get(edge.from);
    if (bucket) bucket.push(edge); else out.set(edge.from,[edge]);
  }
  return out;
}

/** Nodes reachable within a couple of hops. Enough to tell a submit handler from a sibling component. */
function reachWithin(outgoing:Map<string,GraphEdge[]>,seed:string,hops:number,cap=120):string[] {
  const seen=new Set<string>();
  let frontier=[seed];
  for (let hop=0;hop<hops&&seen.size<cap;hop+=1) {
    const next:string[]=[];
    for (const node of frontier) {
      for (const edge of outgoing.get(node) ?? []) {
        if (seen.has(edge.to)||seen.size>=cap) continue;
        seen.add(edge.to);
        next.push(edge.to);
      }
    }
    frontier=next;
  }
  return [...seen];
}

/**
 * Pick the node a traversal should start from.
 *
 * Term overlap on the key alone is not enough: "Contact captcha token" matches
 * ContactInfoBand as readily as ContactForm. Candidates are therefore scored on
 * what they reach as well as what they are named, a node with no outgoing edges
 * is never chosen (it would produce an empty pack), and ties go to the smaller
 * subtree so the most specific entry point wins over the page that contains it.
 */
function resolveSeed(question:string,edges:GraphEdge[],explicit:string[],mode:"flow"|"impact"):string|null {
  const outgoing=outgoingIndex(edges);
  const queryTerms=new Set(terms(question));

  if (explicit.length) {
    const exact=explicit.find((value)=>edges.some((edge)=>edge.from===value||edge.to===value||edge.from.startsWith(`${value}#`)||edge.to.startsWith(`${value}#`)));
    if (exact) {
      if (mode==="impact") return exact;
      // A file is not a traversal entry point; descend to the symbols it declares.
      if (outgoing.has(exact)&&(outgoing.get(exact) ?? []).length) return exact;
      const holders=[...outgoing.keys()].filter((key)=>key.startsWith(`${exact}#`));
      if (holders.length===1) return holders[0]!;
      if (holders.length) {
        const best=holders
          .map((key)=>({key,score:reachWithin(outgoing,key,2).filter((node)=>terms(node).some((term)=>queryTerms.has(term))).length}))
          .sort((a,b)=>b.score-a.score||a.key.localeCompare(b.key))[0];
        if (best) return best.key;
      }
      if (mode==="flow") return exact;
    }
  }

  const candidates=[...new Set(edges.flatMap((edge)=>mode==="flow" ? [edge.from] : [edge.from,edge.to]))];
  const scored=candidates.map((key)=>{
    const outDegree=(outgoing.get(key) ?? []).length;
    const keyTerms=terms(key);
    let score=keyTerms.filter((item)=>queryTerms.has(item)).length*4;
    const reach=mode==="flow"&&outDegree ? reachWithin(outgoing,key,2) : [];
    // What a candidate reaches is the better signal for a flow question. Scoring by
    // distinct covered terms instead was tried and measured worse: it favours broad
    // subtrees over the specific handler, and regressed the captcha flow case.
    score+=reach.filter((node)=>terms(node).some((term)=>queryTerms.has(term))).length*2;
    if (mode==="flow"&&/#(?:handleSubmit|POST|GET|.*Page)$/.test(key)) score+=2;
    if (mode==="impact"&&(/^[A-Z][A-Z0-9_]+$/.test(key)||/adapter|config|manifest/i.test(key))) score+=1;
    return {key,score,outDegree,reachSize:reach.length};
  }).filter((item)=>item.score>0&&(mode==="impact"||item.outDegree>0))
    .sort((a,b)=>b.score-a.score
      // The most specific entry point wins over the page that merely contains it.
      ||a.reachSize-b.reachSize
      ||a.key.localeCompare(b.key));
  return scored[0]?.key ?? null;
}

export class TaskContextCompiler {
  private readonly store:MemoryStore;
  private readonly snapshots=new Map<string,Promise<SemanticSnapshot>>();
  private readonly temporal:TemporalContextEngine;
  constructor(private readonly memoryDb:MemoryDatabase) { this.store=new MemoryStore(memoryDb); this.temporal=new TemporalContextEngine(this.store); }

  private snapshot(repository:string):Promise<SemanticSnapshot> {
    const row=this.store.getRepository(repository);
    if (!row) return Promise.reject(new Error(`Repository not found: ${repository}`));
    const key=`${repository}:${row.last_indexed_sha ?? "unknown"}`;
    const cached=this.snapshots.get(key);
    if (cached) return cached;
    const pending=(async()=>{
      const repoPath=String(row.path);
      const files=await walkFiles(repoPath);
      const routes=this.store.listRoutes(repository).map((route:any)=>({route:route.route,sourceFile:route.source_file,routeType:route.route_type}));
      const edges=await extractSymbolGraph(repoPath,files,routes.map((route)=>route.route));
      return {edges,routes,files,repoPath};
    })();
    this.snapshots.set(key,pending);
    return pending;
  }

  async compile(question:string,options:{repository:string;types?:MemoryType[];maxChars?:number;since?:string;atSha?:string;compareToSha?:string;freshness?:Record<string,unknown>}):Promise<any> {
    const maxChars=Math.max(1_000,Math.min(24_000,options.maxChars ?? 8_000));
    // Part of the pack, so it is budgeted with the pack rather than appended after.
    const freshness=options.freshness;
    if (options.compareToSha&&!options.atSha) throw new Error("compareToSha requires atSha as the behavior-diff base");
    if (options.atSha&&options.compareToSha) return this.temporal.behaviorDiff(options.repository,options.atSha,options.compareToSha,maxChars);
    if (options.atSha) return this.temporal.contextAtSha(options.repository,options.atSha,question,maxChars);
    if (isDecisionQuestion(question)) return buildDecisionContext(this.store,options.repository,question,maxChars);
    const plan=planQuery(question,{repo:options.repository,memoryTypes:options.types});
    const repository=this.store.getRepository(options.repository);
    if (!repository) throw new Error(`Repository not found: ${options.repository}`);
    const snapshotSha=repository.last_indexed_sha as string|null;

    if (!["explain-flow","impact","implementation-plan","debug","change-review","verify"].includes(plan.intent)) {
      return buildAgentContext(this.memoryDb,question,{repository:options.repository,memoryTypes:options.types,maxChars,
        metadata:{schemaVersion:"1.0",kind:plan.intent,intent:plan.intent,snapshotSha,...(freshness ? {freshness} : {})}});
    }

    // A repository-wide strategy question needs representative facts, not a
    // failure-path graph. Keep it below the source-read break-even point; the
    // repository profile is supplied by the companion repository tool.
    if ((plan.intent==="debug"||plan.intent==="verify")&&isRepositoryStrategyQuestion(question)) {
      return buildAgentContext(this.memoryDb,question,{repository:options.repository,memoryTypes:options.types,maxChars:Math.min(maxChars,4_000),
        metadata:{schemaVersion:"1.0",kind:"repository-strategy",intent:plan.intent,snapshotSha,...(freshness ? {freshness} : {})}});
    }

    let semantic:SemanticSnapshot;
    try { semantic=await this.snapshot(options.repository); }
    catch (error) {
      const reason=`semantic graph unavailable: ${(error as Error).message}`;
      return buildAgentContext(this.memoryDb,question,{repository:options.repository,memoryTypes:options.types,maxChars,
        metadata:{schemaVersion:"1.0",kind:plan.intent,intent:plan.intent,snapshotSha,...(freshness ? {freshness} : {})},uncertainty:[reason]});
    }

    const explicit=[...plan.anchors.symbols,...plan.anchors.files,...plan.anchors.config,...(plan.anchors.route ? [plan.anchors.route] : [])];
    // Traversal packs use hybrid results only as targeted source fallback, so a
    // wider file set improves recall without injecting extra facts into the pack.
    // Fact-bearing debug packs stay tight; implementation needs a few exemplars.
    const retrievalLimit=plan.intent==="explain-flow"||plan.intent==="impact" ? 20
      : plan.intent==="implementation-plan"||plan.intent==="verify" ? 15 : 10;
    const ranked=await hybridSearch(this.memoryDb,question,{repo:options.repository,memoryTypes:options.types,limit:retrievalLimit});
    const fallbackFiles=[...new Set(ranked.flatMap((item)=>item.sourceFiles ?? (item.sourceFile ? [item.sourceFile] : [])))];
    const rankedSymbols=ranked.flatMap((item)=>item.sourceFile&&item.sourceSymbol ? [`${item.sourceFile}#${item.sourceSymbol}`] : []);

    if (plan.intent==="explain-flow") {
      // A submit handler is a concrete execution boundary and beats a page-level
      // lexical match when semantic retrieval put it first. Other ranked symbols
      // are only a last resort; menu/data helpers must not displace layout flows.
      const topHandler=ranked[0]?.sourceSymbol==="handleSubmit" ? rankedSymbols[0] : undefined;
      const seed=(topHandler ? resolveSeed(question,semantic.edges,[topHandler],"flow") : null)
        ?? resolveSeed(question,semantic.edges,explicit,"flow")
        ?? resolveSeed(question,semantic.edges,rankedSymbols.slice(0,3),"flow");
      if (!seed) return compileContextPack({freshness,kind:"flow",query:question,repository:options.repository,snapshotSha,
        trace:{seed:"unresolved",steps:[],endpoints:[],config:[],prunedSteps:0,truncated:false},gaps:["flow seed could not be resolved"],sourceFallback:fallbackFiles},{maxChars});
      const routeFiles=new Map(semantic.routes.map((route)=>[route.route,route.sourceFile]));
      return compileContextPack({freshness,kind:"flow",query:question,repository:options.repository,snapshotSha,
        trace:traceFlow(semantic.edges,seed,{routeEntries:routeEntriesFrom(semantic.edges,routeFiles)}),sourceFallback:fallbackFiles},{maxChars});
    }

    if (plan.intent==="impact") {
      const seed=resolveSeed(question,semantic.edges,explicit,"impact");
      const trace=seed ? traceImpact(semantic.edges,seed,{routes:semantic.routes})
        : {seed:"unresolved",steps:[],files:[],symbols:[],components:[],routes:[],apiRoutes:[],config:[],endpoints:[],tests:[],truncated:false};
      return compileContextPack({freshness,kind:"impact",query:question,repository:options.repository,snapshotSha,trace,
        ...(seed ? {} : {gaps:["impact seed could not be resolved"]}),sourceFallback:fallbackFiles},{maxChars});
    }

    const verification=await extractVerificationGraph(semantic.repoPath,semantic.files,{routes:semantic.routes,
      targets:semantic.routes.map((route)=>({key:route.route,kind:"route",file:route.sourceFile}))});

    if (plan.intent==="implementation-plan"||plan.intent==="verify") {
      const seed=resolveSeed(question,semantic.edges,explicit,"impact");
      const impact=seed ? traceImpact(semantic.edges,seed,{routes:semantic.routes}) : undefined;
      return compileContextPack({freshness,kind:"implementation",query:question,repository:options.repository,snapshotSha,
        exemplars:ranked,impact,verification,sourceFallback:fallbackFiles},{maxChars});
    }

    if (plan.intent==="debug") {
      const seed=resolveSeed(question,semantic.edges,explicit,"flow");
      const routeFiles=new Map(semantic.routes.map((route)=>[route.route,route.sourceFile]));
      const trace=seed ? traceFlow(semantic.edges,seed,{routeEntries:routeEntriesFrom(semantic.edges,routeFiles)}) : undefined;
      return compileContextPack({freshness,kind:"debug",query:question,repository:options.repository,snapshotSha,facts:ranked,trace,
        ...(seed ? {} : {gaps:["failure-path seed could not be resolved"]}),sourceFallback:fallbackFiles},{maxChars});
    }

    const rows=this.store.listMemoryChanges(options.repository,options.since).map((row:any)=>({operation:row.operation,
      entity:`${row.memory_type ?? "memory"}:${row.subject ?? row.memory_id}`,file:row.source_file,fromSha:row.from_sha,toSha:row.to_sha}));
    const changedFile=rows.find((row:any)=>row.file)?.file;
    const impact=changedFile ? traceImpact(semantic.edges,changedFile,{routes:semantic.routes}) : undefined;
    return compileContextPack({freshness,kind:"change-review",query:question,repository:options.repository,snapshotSha,
      changes:rows,impact,verification,...(!options.since ? {gaps:["no since SHA supplied; returning indexed change audit"]} : {})},{maxChars});
  }
}
