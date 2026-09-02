import type { GraphEdge } from "../analyzers/symbol-graph.js";
import { extractSymbolGraph } from "../analyzers/symbol-graph.js";
import { extractVerificationGraph } from "../analyzers/verification-graph.js";
import type { MemoryDatabase } from "../memory/database.js";
import { MemoryStore } from "../memory/store.js";
import type { MemoryType } from "../types.js";
import { walkFiles } from "../utils/walk.js";
import { compileContextPack, type RetrievalRounds } from "./context-pack.js";
import { buildAgentContext } from "./context.js";
import { routeEntriesFrom, traceFlow } from "./flow.js";
import { traceImpact, type ImpactRoute } from "./impact.js";
import { decideSecondRound, planQuery, type QueryPlan, type RetrievalOutcome, type SecondRoundDecision } from "./query-plan.js";
import { hybridSearch } from "./search.js";
import { TemporalContextEngine } from "./temporal.js";
import { buildDecisionContext, isDecisionQuestion } from "./decision-context.js";
import { createAnswerContract } from "./answer-contract.js";
import { routesEquivalent } from "./route-identity.js";
import { queryTerms, relevanceScore } from "./relevance.js";
import { aliasRouteMatch, matchingAliasRoute, normalizeQueryAliases } from "./query-vocabulary.js";

interface SemanticSnapshot {
  edges:GraphEdge[];
  routes:Array<ImpactRoute&{layoutChain:string[];clientBoundaries:string[]}>;
  files:string[];
  repoPath:string;
}

function jsonArray(value:unknown):string[] {
  try {
    const parsed=JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

function jsonValue(value:unknown,fallback:any):any {
  try { return value ? JSON.parse(String(value)) : fallback; }
  catch { return fallback; }
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

function isRepositoryDependencyQuestion(question:string):boolean {
  return /\b(cross[- ]repo|inter[- ]repo|repository dependenc|repo dependenc|depends on (?:which )?repo|which repo(?:s)? (?:uses?|consumes?))\b/i.test(question)
    || /(?:repo|repository).{0,30}(?:bağımlı|bağımlılık|kullanıyor|tüketiyor)|(?:bağımlı|bağımlılık).{0,30}(?:repo|repository)/i.test(question);
}

function isDataFlowQuestion(question:string):boolean {
  return /\b(data|fetch|endpoint|service chain)\b/i.test(question)
    || /(?:ürün|sayfa).{0,30}(?:veri(?:si|sini)?|servis zinciri)|(?:veri|servis zinciri).{0,30}(?:nereden|akış|alır|getirir)/i.test(question);
}

/**
 * Nodes that submit to a route. The analyzer types this edge, so a submit
 * boundary is recognised whatever the project calls its handler — `handleSubmit`,
 * `onSubmit`, `postComment` — instead of only where one naming convention holds.
 */
function submitBoundaries(edges:GraphEdge[]):Set<string> {
  return new Set(edges.filter((edge)=>edge.type==="submits-to").map((edge)=>edge.from));
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
  const submits=submitBoundaries(edges);
  const queryTerms=new Set(terms(question));

  if (explicit.length) {
    const exact=explicit.flatMap((value)=>{
      const direct=edges.some((edge)=>edge.from===value||edge.to===value||edge.from.startsWith(`${value}#`)||edge.to.startsWith(`${value}#`)
        ||(value.startsWith("/")&&(routesEquivalent(edge.from,value)||routesEquivalent(edge.to,value))));
      if (direct) return [value];
      // Natural questions often name a bare exported function instead of the
      // `file#symbol` graph key. Resolve it only when it is unambiguous.
      if (!value.includes("/")&&!value.includes("#")) {
        const nodes=[...new Set(edges.flatMap((edge)=>[edge.from,edge.to]))].filter((node)=>node.endsWith(`#${value}`));
        if (nodes.length===1) return nodes;
      }
      return [];
    })[0];
    if (exact) {
      if (mode==="impact") return exact;
      // A file is not a traversal entry point; descend to the symbols it declares.
      if (outgoing.has(exact)&&(outgoing.get(exact) ?? []).length) return exact;
      const holders=[...outgoing.keys()].filter((key)=>key.startsWith(`${exact}#`));
      if (holders.length===1) return holders[0]!;
      if (holders.length) {
        const pageEntry=holders.find((key)=>key.endsWith("#Page"));
        if (pageEntry&&!/\b(?:metadata|seo|generateMetadata)\b/i.test(question)) return pageEntry;
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
    // A framework entry point (route handler, page) or a typed submit boundary
    // is a concrete place for a flow to start.
    if (mode==="flow"&&(submits.has(key)||/#(?:POST|GET|PUT|PATCH|DELETE|HEAD|OPTIONS|.*Page)$/.test(key))) score+=2;
    if (mode==="impact"&&(/^[A-Z][A-Z0-9_]+$/.test(key)||/adapter|config|manifest/i.test(key))) score+=1;
    return {key,score,outDegree,reachSize:reach.length};
  }).filter((item)=>item.score>0&&(mode==="impact"||item.outDegree>0))
    .sort((a,b)=>b.score-a.score
      // The most specific entry point wins over the page that merely contains it.
      ||a.reachSize-b.reachSize
      ||a.key.localeCompare(b.key));
  return scored[0]?.key ?? null;
}


/**
 * Route/source lookups are answered from the routes table, not from lexical
 * search: the question names a page, and the structured row *is* the answer.
 * `memory_route` already did this; `memory_context` did not, so the browser UI
 * and any agent that only called the context tool fell through to hybrid search.
 */
function isRouteLookupQuestion(question:string):boolean {
  return /\b(route|url|path|sayfa\w*|page|source|kaynak|dosya\w*|file|nerede|where|render\w*|ssr|ssg|isr|csr)\b/i.test(question);
}

/** Derived vocabulary contains generic fragments ("api", "auth", "form"); acting on a route needs a specific mention. */
const MIN_ALIAS_STRENGTH=6;

function routeLookupEvidence(row:any):string[] {
  const source=String(row.source_file);
  return jsonArray(row.evidence_json).filter((item)=>item.startsWith(`${source}:`)).slice(0,6);
}

function trimToBudget(pack:any,maxChars:number):void {
  const optional:Array<[string,()=>boolean]>=[
    ["route.renderingEvidence",()=>{ if (!pack.route.renderingEvidence?.length) return false; pack.route.renderingEvidence.pop(); return true; }],
    ["relatedRoutes",()=>{ if (!pack.relatedRoutes?.length) return false; pack.relatedRoutes.pop(); return true; }],
    ["route.controlFlow",()=>{ if (!pack.route.controlFlow?.length) return false; pack.route.controlFlow.pop(); return true; }],
  ];
  for (let guard=0;JSON.stringify(pack).length>maxChars&&guard<200;guard+=1) {
    const step=optional.find(([,pop])=>pop());
    if (!step) break;
    pack.budget.truncated=true;
    pack.budget.omitted[step[0]]=(pack.budget.omitted[step[0]] ?? 0)+1;
  }
  pack.budget.usedChars=JSON.stringify(pack).length;
  pack.budget.estimatedTokens=Math.ceil(pack.budget.usedChars/3.5);
}


/**
 * The planned rounds, actually executed.
 *
 * Round one is the plan's primary channel set. Round two — the conditional
 * recovery pass whose only effect on a compiled pack is the targeted source
 * fallback it offers — runs when, and only when, the round-one outcome trips a
 * trigger the plan declared. Reporting it on the pack means the answer states
 * which channels produced it and what was still missing.
 */
function retrievalRounds(plan:QueryPlan,outcome:RetrievalOutcome):{rounds:RetrievalRounds;second:SecondRoundDecision} {
  const second=decideSecondRound(plan,outcome);
  const channels=(round:0|1):string[]=>[...new Set((plan.rounds[round]?.steps ?? []).map((step)=>step.channel))];
  return {rounds:{rounds:[...channels(0),...(second.run ? channels(1) : [])],
    secondRound:{run:second.run,triggers:second.triggers}},second};
}

/** Share of relation rows that carry a located source file. */
function relationCoverage(rows:Array<{file?:string|null}>):number|undefined {
  if (!rows.length) return undefined;
  return rows.filter((row)=>row.file).length/rows.length;
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
      const routes=this.store.listRoutes(repository).map((route:any)=>({route:route.route,sourceFile:route.source_file,routeType:route.route_type,
        layoutChain:jsonArray(route.layout_chain_json),clientBoundaries:jsonArray(route.client_boundaries_json)}));
      // Retrieval uses the current analyzer semantics. A graph persisted by an
      // older analyzer revision can share the same repository SHA yet miss new
      // edge types, so snapshot reuse here would silently regress answer recall.
      const edges=await extractSymbolGraph(repoPath,files,routes.map((route)=>route.route));
      return {edges,routes,files,repoPath};
    })();
    this.snapshots.set(key,pending);
    return pending;
  }


  /**
   * Resolve the page the question names — by explicit path or by registry
   * vocabulary — and answer from the routes table. Returns null when nothing
   * resolves confidently, so the caller can fall back to semantic retrieval.
   */
  private routeLookup(question:string,repositoryName:string,repository:any,anchorRoute:string|undefined,
    maxChars:number,snapshotSha:string|null,freshness:Record<string,unknown>|undefined):any {
    const routes=this.store.listRoutes(repositoryName) as any[];
    if (!routes.length) return null;
    let aliases={};
    try { aliases=normalizeQueryAliases(JSON.parse(String(repository.query_aliases_json ?? "{}"))); } catch {}
    const alias=anchorRoute ? undefined : aliasRouteMatch(question,[aliases],routes.map((row)=>String(row.route)));
    const resolved=anchorRoute ?? (alias&&alias.strength>=MIN_ALIAS_STRENGTH ? alias.route : undefined);
    if (!resolved) return null;
    const row=routes.find((item)=>routesEquivalent(String(item.route),resolved));
    if (!row) return null;

    const sourceFile=String(row.source_file);
    // Optional sections are attached only when the question asks for them. A
    // lookup that names one page should not pay for its siblings or for
    // rendering provenance it never asked about.
    // Siblings are attached when the question asks for them, or when the
    // vocabulary matched a fragment rather than the page's own name — that
    // ambiguity is exactly when the neighbouring routes are worth showing.
    const wantsSiblings=(alias ? !alias.canonicalMentioned : false)
      ||/\b(route'?lar\w*|routes|sayfalar\w*|alt sayfa\w*|sub ?routes?)\b/i.test(question);
    const wantsRenderingEvidence=/\b(render\w*|ssr|ssg|isr|csr|static|dynamic|cache|neden|why)\b/i.test(question);
    const related=wantsSiblings
      ? routes.filter((item)=>item.route!==row.route&&String(item.route).startsWith(`${row.route === "/" ? "" : row.route}/`))
        .slice(0,5).map((item)=>({route:item.route,sourceFile:item.source_file}))
      : [];
    const pack:any={schemaVersion:"1.0",kind:"lookup",intent:"lookup",query:question,repository:repositoryName,snapshotSha,
      ...(freshness ? {freshness} : {}),
      retrieval:{rounds:["exact-sql"],resolvedBy:anchorRoute ? "route-anchor" : "registry-vocabulary",
        secondRound:{run:false,triggers:[]}},
      route:{claimKind:"fact",route:row.route,type:row.route_type,router:row.router_type,sourceFile,
        rendering:row.rendering_mode,renderingBasis:row.rendering_basis ?? "observed",
        serverComponent:row.server_component==null ? null : Boolean(row.server_component),
        authRequired:row.auth_required==null ? null : Boolean(row.auth_required),
        lastSeenSha:row.last_seen_sha,
        controlFlow:jsonValue(row.control_flow_json,[]),
        evidence:[{file:sourceFile,line:null,symbol:null,confidence:"observed"}],
        ...(wantsRenderingEvidence ? {renderingEvidence:routeLookupEvidence(row)} : {})},
      ...(related.length ? {relatedRoutes:related} : {}),
      budget:{maxChars,usedChars:0,estimatedTokens:0,truncated:false,omitted:{} as Record<string,number>}};
    pack.answerContract=createAnswerContract({
      facts:["route.route","route.sourceFile","route.rendering"],
      derivedRelations:related.length ? ["relatedRoutes"] : [],
      uncertainty:[],missingEvidence:[],
      // The structured row carries the file itself; there is nothing left to open.
      sourceFallback:[],empty:false,
    });
    trimToBudget(pack,maxChars);
    return pack;
  }

  async compile(question:string,options:{repository:string;types?:MemoryType[];maxChars?:number;since?:string;atSha?:string;compareToSha?:string;freshness?:Record<string,unknown>;reserveChars?:number}):Promise<any> {
    let maxChars=Math.max(1_000,Math.min(24_000,options.maxChars ?? 8_000));
    // Part of the pack, so it is budgeted with the pack rather than appended after.
    const freshness=options.freshness;
    if (options.compareToSha&&!options.atSha) throw new Error("compareToSha requires atSha as the behavior-diff base");
    if (options.atSha&&options.compareToSha) return this.temporal.behaviorDiff(options.repository,options.atSha,options.compareToSha,maxChars);
    if (options.atSha) return this.temporal.contextAtSha(options.repository,options.atSha,question,maxChars);
    if (isDecisionQuestion(question)) return buildDecisionContext(this.store,options.repository,question,maxChars);
    const plan=planQuery(question,{repo:options.repository,memoryTypes:options.types});
    if (options.maxChars==null) {
      const automaticBudget:Partial<Record<typeof plan.intent,number>>={
        // General ordered flows can legitimately cross validation, a route
        // boundary and gateway config. Data-focused flows still self-prune to a
        // much smaller payload, so keeping the general ceiling avoids recall loss.
        // A structured route answer costs ~1.5k; a lexical lookup returns up to
        // five evidence-bearing facts, which does not fit in 3k and made every
        // lookup report itself as budget-truncated.
        // Each ceiling must carry what its plan actually retrieves: a debug plan
        // asks for ten failure facts, and 4.5k dropped three of them — including
        // the one that explained the failure.
        lookup:6_000,"explain-flow":8_000,impact:4_500,"implementation-plan":5_500,debug:6_000,verify:4_000,"change-review":5_000,unknown:4_000,
      };
      maxChars=Math.min(maxChars,automaticBudget[plan.intent] ?? maxChars);
    }
    // The caller annotates the delivered pack (with a telemetry id), so the
    // content must be fitted below the number the pack declares — otherwise the
    // payload that actually ships is larger than the budget it reports.
    maxChars=Math.max(1_000,maxChars-(options.reserveChars ?? 0));
    const repositoryStrategy=isRepositoryStrategyQuestion(question);
    const repository=this.store.getRepository(options.repository);
    if (!repository) throw new Error(`Repository not found: ${options.repository}`);
    const snapshotSha=repository.last_indexed_sha as string|null;

    if (isRepositoryDependencyQuestion(question)) {
      const relations=this.store.listRepositoryLinks(options.repository).map((link:any)=>({
        claimKind:"derived-relation",
        direction:link.direction,
        consumerRepository:link.consumer_repository,
        providerRepository:link.provider_repository,
        packageName:link.package_name,
        dependencyKind:link.dependency_kind,
        evidence:{repository:link.consumer_repository,file:link.source_file,sha:link.last_seen_sha},
      }));
      const pack:any={schemaVersion:"1.0",kind:"repository-dependencies",query:question,repository:options.repository,snapshotSha,
        ...(freshness ? {freshness} : {}),relations,
        budget:{maxChars,usedChars:0,estimatedTokens:0,truncated:false,omitted:{}},
        answerContract:createAnswerContract({derivedRelations:relations.length ? ["relations"] : [],
          facts:relations.length ? ["relations[*].packageName"] : [],
          uncertainty:[],missingEvidence:[],sourceFallback:[],empty:false}),
      };
      while (JSON.stringify(pack).length>maxChars&&pack.relations.length) {
        pack.relations.pop();
        pack.budget.truncated=true;
        pack.budget.omitted.relations=(pack.budget.omitted.relations ?? 0)+1;
      }
      if (pack.budget.truncated) pack.answerContract=createAnswerContract({
        derivedRelations:pack.relations.length ? ["relations"] : [],facts:pack.relations.length ? ["relations[*].packageName"] : [],
        truncated:true,empty:false,
      });
      pack.budget.usedChars=JSON.stringify(pack).length;
      pack.budget.estimatedTokens=Math.ceil(pack.budget.usedChars/3.5);
      return pack;
    }

    if (!["explain-flow","impact","implementation-plan","debug","change-review","verify"].includes(plan.intent)) {
      // Round 1 of the query plan, actually executed: exact structured lookup.
      // An explicit path in the question is a route lookup whatever else it asks.
      const structured=plan.anchors.route||isRouteLookupQuestion(question)
        ? this.routeLookup(question,options.repository,repository,plan.anchors.route,maxChars,snapshotSha,freshness)
        : null;
      if (structured) return structured;
      // Round 2 runs only on a measured round-1 miss, as the plan declares.
      const second=decideSecondRound(plan,{resultCount:0,evidenceCount:0,
        unresolvedAnchors:plan.anchors.route ? [plan.anchors.route] : []});
      return buildAgentContext(this.memoryDb,question,{repository:options.repository,memoryTypes:options.types,maxChars,
        metadata:{schemaVersion:"1.0",kind:plan.intent,intent:plan.intent,snapshotSha,...(freshness ? {freshness} : {}),
          retrieval:{rounds:["exact-sql","fts","vector"],secondRound:second}}});
    }

    // A repository-wide strategy question needs representative facts, not a
    // failure-path graph. Keep it below the source-read break-even point; the
    // repository profile is supplied by the companion repository tool.
    if (plan.intent==="debug"&&repositoryStrategy) {
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

    let aliases={};
    try { aliases=normalizeQueryAliases(JSON.parse(String(repository.query_aliases_json ?? "{}"))); } catch {}
    const aliasRoute=matchingAliasRoute(question,[aliases],semantic.routes.map((route)=>route.route));
    const resolvedRoute=plan.anchors.route ?? aliasRoute;
    const routeSource=resolvedRoute
      ? semantic.routes.find((route)=>routesEquivalent(route.route,resolvedRoute))?.sourceFile
      : undefined;
    const explicit=[...plan.anchors.symbols,...plan.anchors.files,...plan.anchors.config,
      ...(routeSource ? [routeSource] : []),...(resolvedRoute ? [resolvedRoute] : [])];
    // Traversal packs use hybrid results only as targeted source fallback, so a
    // wider file set improves recall without injecting extra facts into the pack.
    // Fact-bearing debug packs stay tight; implementation needs a few exemplars.
    const retrievalLimit=plan.intent==="explain-flow"||plan.intent==="impact" ? 20
      : plan.intent==="implementation-plan"||plan.intent==="verify" ? 15 : 10;
    // A repository-wide verification question that explicitly names a semantic
    // surface (for example error handling) needs facts from that surface plus
    // the verification graph, not unrelated high-quality repository memories.
    const focusedTypes=options.types ?? (plan.intent==="verify"&&repositoryStrategy&&plan.memoryTypes.length ? plan.memoryTypes : undefined);
    const ranked=await hybridSearch(this.memoryDb,question,{repo:options.repository,memoryTypes:focusedTypes,limit:retrievalLimit});
    const fallbackFiles=[...new Set(ranked.flatMap((item)=>item.sourceFiles ?? (item.sourceFile ? [item.sourceFile] : [])))];
    const rankedSymbols=ranked.flatMap((item)=>item.sourceFile&&item.sourceSymbol ? [`${item.sourceFile}#${item.sourceSymbol}`] : []);

    if (plan.intent==="explain-flow") {
      // A submit handler is a concrete execution boundary and beats a page-level
      // lexical match when semantic retrieval put it first. Other ranked symbols
      // are only a last resort; menu/data helpers must not displace layout flows.
      // A node that submits to a route is a concrete execution boundary, but only
      // for a question about submitting something: seeding a layout/menu flow at a
      // form handler answers a question nobody asked. Near the top of the ranking
      // is enough — a lexically strong route fact can outrank the handler without
      // meaning the flow starts at the page — and among several boundaries the one
      // the question actually names wins.
      const questionTerms=queryTerms(question);
      const submits=submitBoundaries(semantic.edges);
      const submitQuestion=/\b(form\w*|submit\w*|g[öo]nder\w*|kaydet\w*|girdi\w*|input|payload)\b/i.test(question);
      const handler=submitQuestion
        ? ranked.slice(0,3).filter((item)=>item.sourceFile&&item.sourceSymbol
            &&submits.has(`${item.sourceFile}#${item.sourceSymbol}`))
          .sort((a,b)=>relevanceScore(questionTerms,{subject:b.subject,sourceFile:b.sourceFile})
            -relevanceScore(questionTerms,{subject:a.subject,sourceFile:a.sourceFile}))[0]
        : undefined;
      const topHandler=handler ? `${handler.sourceFile}#${handler.sourceSymbol}` : undefined;
      const clientEntry=/\b(?:client|browser|csr)\b/i.test(question)
        ? ranked.find((item)=>/(?:^|\/)client\.[cm]?[jt]sx?$/i.test(item.sourceFile ?? ""))?.sourceFile
        : undefined;
      const seed=(topHandler ? resolveSeed(question,semantic.edges,[topHandler],"flow") : null)
        ?? (clientEntry ? resolveSeed(question,semantic.edges,[clientEntry],"flow") : null)
        ?? resolveSeed(question,semantic.edges,explicit,"flow")
        ?? resolveSeed(question,semantic.edges,rankedSymbols.slice(0,3),"flow");
      if (!seed) return compileContextPack({freshness,
        retrieval:retrievalRounds(plan,{resultCount:0,evidenceCount:0,unresolvedAnchors:["flow seed"]}).rounds,
        kind:"flow",query:question,repository:options.repository,snapshotSha,
        trace:{seed:"unresolved",steps:[],endpoints:[],config:[],prunedSteps:0,truncated:false},gaps:["flow seed could not be resolved"],sourceFallback:fallbackFiles},{maxChars});
      const routeFiles=new Map(semantic.routes.map((route)=>[route.route,route.sourceFile]));
      const routeEntries=routeEntriesFrom(semantic.edges,routeFiles);
      const focused=isDataFlowQuestion(question) ? traceFlow(semantic.edges,seed,{routeEntries,focus:"data"}) : null;
      // Some repositories hide the actual HTTP boundary behind an unanalyzable
      // SDK. In that case retain the ordinary service chain instead of returning
      // an empty focused pack.
      const trace=focused?.steps.length ? focused : traceFlow(semantic.edges,seed,{routeEntries,focus:"all"});
      const routeRecord=resolvedRoute ? semantic.routes.find((route)=>routesEquivalent(route.route,resolvedRoute)) : undefined;
      const routeDir=routeRecord?.sourceFile.slice(0,routeRecord.sourceFile.lastIndexOf("/"));
      // The route's own client entry first, whatever the route file is called:
      // `page.tsx` → `page.client.*`, `route.ts` → `route.client.*`.
      const entryStem=routeRecord?.sourceFile.slice(routeRecord.sourceFile.lastIndexOf("/")+1).split(".")[0];
      const isEntryClient=(file:string):boolean=>Boolean(entryStem&&routeDir
        &&new RegExp(`^${routeDir}/${entryStem}\\.client\\.[cm]?[jt]sx?$`).test(file));
      const localBoundaries=routeRecord&&routeDir ? routeRecord.clientBoundaries
        .filter((file)=>file.startsWith(`${routeDir}/`))
        .sort((a,b)=>Number(isEntryClient(b))-Number(isEntryClient(a))||a.localeCompare(b))
        .slice(0,6) : [];
      const includeRouteContext=/(?:kullanıcı akışı|user flow|layout|client boundary)/i.test(question);
      const flowRounds=retrievalRounds(plan,{resultCount:trace.steps.length,
        evidenceCount:trace.steps.filter((step)=>step.file).length,
        relationCoverage:relationCoverage(trace.steps),truncated:trace.truncated});
      return compileContextPack({freshness,retrieval:flowRounds.rounds,kind:"flow",query:question,repository:options.repository,snapshotSha,
        trace,...(routeRecord&&includeRouteContext ? {routeContext:{route:routeRecord.route,sourceFile:routeRecord.sourceFile,
          layouts:routeRecord.layoutChain,clientBoundaries:localBoundaries}} : {}),
        sourceFallback:flowRounds.second.run ? fallbackFiles : []},{maxChars});
    }

    if (plan.intent==="impact") {
      const seed=resolveSeed(question,semantic.edges,explicit,"impact");
      const trace=seed ? traceImpact(semantic.edges,seed,{routes:semantic.routes})
        : {seed:"unresolved",steps:[],files:[],symbols:[],components:[],routes:[],apiRoutes:[],config:[],endpoints:[],tests:[],truncated:false};
      // Unlike a flow trace, a reverse-dependency closure is inherently partial
      // (an edge the analyzer cannot follow simply is not there), so the ranked
      // files stay on offer even when the traversal itself did not truncate.
      // A reverse-dependency closure is only as complete as the edges the
      // analyzer could follow, so its relation coverage decides whether the
      // recovery round has anything to add.
      // Affected entities are results even when no relation row survived the
      // budget, so the outcome must count them or a useful pack reports itself
      // as empty.
      const affectedCount=(["routes","apiRoutes","components","files","config","endpoints","tests"] as const)
        .reduce((total,key)=>total+trace[key].length,0);
      const impactRounds=retrievalRounds(plan,{resultCount:trace.steps.length+affectedCount,
        evidenceCount:trace.steps.filter((step)=>step.file).length,
        relationCoverage:relationCoverage(trace.steps),truncated:trace.truncated,
        unresolvedAnchors:seed ? [] : ["impact seed"]});
      return compileContextPack({freshness,retrieval:impactRounds.rounds,kind:"impact",query:question,repository:options.repository,snapshotSha,trace,
        ...(seed ? {} : {gaps:["impact seed could not be resolved"]}),
        sourceFallback:impactRounds.second.run ? fallbackFiles : []},{maxChars});
    }

    const verification=await extractVerificationGraph(semantic.repoPath,semantic.files,{routes:semantic.routes,
      // Repository-level test/build strategy needs package/CI facts and global
      // gaps. Per-route missing-test gaps are irrelevant and previously crowded
      // the useful package.json evidence out of the bounded response.
      targets:plan.intent==="verify"&&repositoryStrategy ? []
        : semantic.routes.map((route)=>({key:route.route,kind:"route",file:route.sourceFile}))});

    if (plan.intent==="implementation-plan"||plan.intent==="verify") {
      const seed=resolveSeed(question,semantic.edges,explicit,"impact");
      const impact=seed ? traceImpact(semantic.edges,seed,{routes:semantic.routes}) : undefined;
      const implementationRounds=retrievalRounds(plan,{resultCount:ranked.length+(impact?.steps.length ?? 0),
        evidenceCount:ranked.filter((item)=>item.sourceFile).length,
        relationCoverage:impact ? relationCoverage(impact.steps) : 0,
        unresolvedAnchors:seed ? [] : explicit.slice(0,1)});
      return compileContextPack({freshness,retrieval:implementationRounds.rounds,kind:"implementation",query:question,repository:options.repository,snapshotSha,
        exemplars:ranked,impact,verification,verificationFirst:plan.intent==="verify",
        sourceFallback:implementationRounds.second.run ? fallbackFiles : []},{maxChars});
    }

    if (plan.intent==="debug") {
      const seed=resolveSeed(question,semantic.edges,explicit,"flow");
      const routeFiles=new Map(semantic.routes.map((route)=>[route.route,route.sourceFile]));
      const trace=seed ? traceFlow(semantic.edges,seed,{routeEntries:routeEntriesFrom(semantic.edges,routeFiles)}) : undefined;
      const debugRounds=retrievalRounds(plan,{resultCount:ranked.length+(trace?.steps.length ?? 0),
        evidenceCount:ranked.filter((item)=>item.sourceFile).length,
        relationCoverage:trace ? relationCoverage(trace.steps) : 0,
        truncated:trace?.truncated ?? false,unresolvedAnchors:seed ? [] : ["failure-path seed"]});
      return compileContextPack({freshness,retrieval:debugRounds.rounds,kind:"debug",query:question,repository:options.repository,snapshotSha,facts:ranked,trace,
        ...(seed ? {} : {gaps:["failure-path seed could not be resolved"]}),
        sourceFallback:debugRounds.second.run ? fallbackFiles : []},{maxChars});
    }

    const rows=this.store.listMemoryChanges(options.repository,options.since).map((row:any)=>({operation:row.operation,
      entity:`${row.memory_type ?? "memory"}:${row.subject ?? row.memory_id}`,file:row.source_file,fromSha:row.from_sha,toSha:row.to_sha}));
    const changedFile=rows.find((row:any)=>row.file)?.file;
    const impact=changedFile ? traceImpact(semantic.edges,changedFile,{routes:semantic.routes}) : undefined;
    const changeRounds=retrievalRounds(plan,{resultCount:rows.length,
      evidenceCount:rows.filter((row:any)=>row.file).length,
      relationCoverage:impact ? relationCoverage(impact.steps) : 0,
      unresolvedAnchors:options.since ? [] : ["since sha"]});
    return compileContextPack({freshness,retrieval:changeRounds.rounds,kind:"change-review",query:question,repository:options.repository,snapshotSha,
      changes:rows,impact,verification,...(!options.since ? {gaps:["no since SHA supplied; returning indexed change audit"]} : {})},{maxChars});
  }
}
