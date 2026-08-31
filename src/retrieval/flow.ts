import type { GraphEdge, GraphEdgeType } from "../analyzers/symbol-graph.js";

/** Edges that carry execution. `exports` is structure, not behaviour, so it never appears in a flow. */
const FLOW_EDGES:GraphEdgeType[]=["calls","submits-to","fetches","renders","reads","references"];

/** Ties on the same line only; line number is the primary order. */
const EDGE_RANK:Record<string,number>={"calls":0,"submits-to":1,"fetches":2,"renders":3,"reads":4,"references":5};

export interface FlowStep {
  order:number;
  depth:number;
  from:string;
  edge:GraphEdgeType;
  to:string;
  file:string;
  line:number;
  symbol:string|null;
  confidence:"observed"|"derived";
  derivationRule?:string;
  /** Set when the step leaves the browser and enters a route handler. */
  boundary?:"client-to-server";
}

export interface FlowTrace {
  seed:string;
  steps:FlowStep[];
  /** Upstream endpoints the flow reaches, in first-seen order. */
  endpoints:string[];
  /** Config keys the flow depends on. */
  config:string[];
  /** Steps dropped because their branch reached nothing significant. */
  prunedSteps:number;
  truncated:boolean;
}

export interface FlowOptions {
  maxSteps?:number;
  maxDepth?:number;
  /** Route key -> entry symbols of its handler, so a submits-to step can continue server-side. */
  routeEntries?:Map<string,string[]>;
  follow?:GraphEdgeType[];
  /** Exploration budget before pruning. Guards pathological graphs. */
  maxExplore?:number;
}

interface FlowNode { edge:GraphEdge; depth:number; children:FlowNode[] }

function moduleOf(key:string):string { return key.split("#")[0] ?? key; }

/**
 * A step matters when it changes layer or touches the outside world. An
 * intra-module call such as `parseContactForm -> readText` is implementation
 * detail of one helper, not a step of the flow.
 */
function isSignificant(edge:GraphEdge):boolean {
  if (edge.type==="submits-to"||edge.type==="fetches"||edge.type==="reads") return true;
  if (edge.type==="references") return false;
  return moduleOf(edge.from)!==moduleOf(edge.to);
}

function index(edges:GraphEdge[],follow:Set<GraphEdgeType>):Map<string,GraphEdge[]> {
  const out=new Map<string,GraphEdge[]>();
  for (const edge of edges) {
    if (!follow.has(edge.type)) continue;
    const bucket=out.get(edge.from);
    if (bucket) bucket.push(edge); else out.set(edge.from,[edge]);
  }
  for (const bucket of out.values()) {
    bucket.sort((a,b)=>a.startLine-b.startLine||(EDGE_RANK[a.type] ?? 9)-(EDGE_RANK[b.type] ?? 9));
  }
  return out;
}

/** Keep a branch only when it, or something under it, is significant. */
function prune(nodes:FlowNode[]):{kept:FlowNode[];dropped:number} {
  let dropped=0;
  const kept:FlowNode[]=[];
  for (const node of nodes) {
    const below=prune(node.children);
    dropped+=below.dropped;
    if (isSignificant(node.edge)||below.kept.length) {
      kept.push({...node,children:below.kept});
    } else {
      dropped+=1;
    }
  }
  return {kept,dropped};
}

/**
 * Walk the graph from one entry point and return the steps in reading order.
 *
 * Depth-first on purpose: a flow reads as "it validates, then mints a captcha,
 * then posts to the handler, which calls upstream" — that is DFS order. The
 * tree is pruned afterwards so helper internals do not spend the step budget.
 */
export function traceFlow(edges:GraphEdge[],seed:string,options:FlowOptions={}):FlowTrace {
  const maxSteps=Math.max(1,Math.min(200,options.maxSteps ?? 40));
  const maxDepth=Math.max(1,Math.min(12,options.maxDepth ?? 6));
  const maxExplore=Math.max(maxSteps,Math.min(2000,options.maxExplore ?? 600));
  const follow=new Set<GraphEdgeType>(options.follow ?? FLOW_EDGES);
  const outgoing=index(edges,follow);

  const visited=new Set<string>();
  let explored=0;
  let exhausted=false;

  const explore=(node:string,depth:number):FlowNode[] => {
    if (depth>maxDepth||visited.has(node)) return [];
    if (explored>=maxExplore) { exhausted=true; return []; }
    visited.add(node);
    const out:FlowNode[]=[];
    for (const edge of outgoing.get(node) ?? []) {
      if (explored>=maxExplore) { exhausted=true; break; }
      explored+=1;
      const children=edge.type==="submits-to"
        ? (options.routeEntries?.get(edge.to) ?? []).flatMap((entry)=>explore(entry,depth+1))
        : edge.type==="reads" ? [] : explore(edge.to,depth+1);
      out.push({edge,depth,children});
    }
    return out;
  };

  const {kept,dropped}=prune(explore(seed,0));

  const steps:FlowStep[]=[];
  const endpoints:string[]=[];
  const config:string[]=[];
  let truncated=exhausted;

  const flatten=(nodes:FlowNode[]):void=>{
    for (const node of nodes) {
      if (steps.length>=maxSteps) { truncated=true; return; }
      const {edge,depth}=node;
      steps.push({
        order:steps.length+1,depth,from:edge.from,edge:edge.type,to:edge.to,
        file:edge.filePath,line:edge.startLine,symbol:edge.symbol,confidence:edge.confidence,
        ...(edge.derivationRule ? {derivationRule:edge.derivationRule} : {}),
        ...(edge.type==="submits-to" ? {boundary:"client-to-server" as const} : {}),
      });
      if (edge.type==="fetches"&&!endpoints.includes(edge.to)) endpoints.push(edge.to);
      if (edge.type==="reads"&&!config.includes(edge.to)) config.push(edge.to);
      flatten(node.children);
    }
  };
  flatten(kept);

  return {seed,steps,endpoints,config,prunedSteps:dropped,truncated};
}

/**
 * Handler entry points per route, derived from `exports` edges on the route's
 * own source file. HTTP method exports come first; other exports are the
 * fallback for a page.
 */
export function routeEntriesFrom(edges:GraphEdge[],routeSourceFiles:Map<string,string>):Map<string,string[]> {
  const methods=new Set(["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"]);
  const exportsByFile=new Map<string,string[]>();
  for (const edge of edges) {
    if (edge.type!=="exports") continue;
    const bucket=exportsByFile.get(edge.filePath);
    if (bucket) bucket.push(edge.to); else exportsByFile.set(edge.filePath,[edge.to]);
  }
  const out=new Map<string,string[]>();
  for (const [route,file] of routeSourceFiles) {
    const exported=exportsByFile.get(file) ?? [];
    const handlers=exported.filter((key)=>methods.has(key.split("#")[1] ?? ""));
    out.set(route,handlers.length ? handlers : exported);
  }
  return out;
}
