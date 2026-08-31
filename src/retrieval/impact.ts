import type { GraphEdge, GraphEdgeType, GraphNodeKind } from "../analyzers/symbol-graph.js";

/** Relations whose source semantically depends on their target. */
const REVERSE_IMPACT_EDGES:GraphEdgeType[]=[
  "calls","renders","reads","fetches","inherits","submits-to","references","delegates-to","tags","invalidates",
];

export interface ImpactRoute {
  route:string;
  sourceFile:string;
  routeType?:string;
}

export interface ImpactStep {
  depth:number;
  /** Entity that may be affected by the changed dependency. */
  affected:string;
  affectedKind:GraphNodeKind;
  via:GraphEdgeType;
  dependency:string;
  file:string;
  line:number;
  symbol:string|null;
  confidence:"observed"|"derived";
  derivationRule?:string;
}

export interface ImpactTrace {
  seed:string;
  steps:ImpactStep[];
  files:string[];
  symbols:string[];
  components:string[];
  routes:string[];
  apiRoutes:string[];
  config:string[];
  endpoints:string[];
  tests:string[];
  truncated:boolean;
}

export interface ImpactOptions {
  maxSteps?:number;
  maxDepth?:number;
  follow?:GraphEdgeType[];
  /** Route identity and source metadata from the route analyzer. */
  routes?:ImpactRoute[];
}

function moduleOf(key:string):string {
  const marker=key.indexOf("#");
  return marker<0 ? key : key.slice(0,marker);
}

function looksLikeFile(key:string):boolean {
  return /(?:^|\/)[^/]+\.(?:[cm]?[jt]sx?|json|ya?ml|css|scss|md)$/.test(key);
}

function addUnique(target:string[],value:string):void {
  if (!target.includes(value)) target.push(value);
}

/**
 * Compute `affected-by` at query time. The relation is deliberately not
 * persisted: persisting a reverse closure would make it stale after any edge
 * changes.
 */
export function traceImpact(edges:GraphEdge[],seed:string,options:ImpactOptions={}):ImpactTrace {
  const maxSteps=Math.max(1,Math.min(500,options.maxSteps ?? 100));
  const maxDepth=Math.max(1,Math.min(20,options.maxDepth ?? 8));
  const followed=new Set(options.follow ?? REVERSE_IMPACT_EDGES);
  const incoming=new Map<string,GraphEdge[]>();
  const outgoingTests=new Map<string,GraphEdge[]>();

  for (const edge of edges) {
    if (followed.has(edge.type)) {
      const bucket=incoming.get(edge.to);
      if (bucket) bucket.push(edge); else incoming.set(edge.to,[edge]);
    }
    // `validated-by` points from production entity to test, unlike dependency
    // edges. Tests therefore travel forward while the impact closure travels reverse.
    if (edge.type==="validated-by") {
      const bucket=outgoingTests.get(edge.from);
      if (bucket) bucket.push(edge); else outgoingTests.set(edge.from,[edge]);
    }
  }
  for (const bucket of incoming.values()) bucket.sort((a,b)=>a.startLine-b.startLine||a.from.localeCompare(b.from));

  const fileSeed=looksLikeFile(seed)&&!seed.includes("#");
  const initial=new Set<string>([seed]);
  if (fileSeed) {
    for (const edge of edges) {
      if (moduleOf(edge.from)===seed) initial.add(edge.from);
      if (moduleOf(edge.to)===seed) initial.add(edge.to);
    }
  }

  const visited=new Set(initial);
  const queue=[...initial].map((key)=>({key,depth:0}));
  const reachedKinds=new Map<string,GraphNodeKind>();
  for (const edge of edges) {
    if (initial.has(edge.from)) reachedKinds.set(edge.from,edge.fromKind);
    if (initial.has(edge.to)) reachedKinds.set(edge.to,edge.toKind);
  }
  const steps:ImpactStep[]=[];
  let truncated=false;

  while (queue.length) {
    const current=queue.shift()!;
    if (current.depth>=maxDepth) {
      if ((incoming.get(current.key)?.length ?? 0)>0) truncated=true;
      continue;
    }
    for (const edge of incoming.get(current.key) ?? []) {
      if (visited.has(edge.from)) continue;
      if (steps.length>=maxSteps) { truncated=true; queue.length=0; break; }
      visited.add(edge.from);
      reachedKinds.set(edge.from,edge.fromKind);
      steps.push({
        depth:current.depth+1,affected:edge.from,affectedKind:edge.fromKind,via:edge.type,
        dependency:edge.to,file:edge.filePath,line:edge.startLine,symbol:edge.symbol,
        confidence:edge.confidence,...(edge.derivationRule ? {derivationRule:edge.derivationRule} : {}),
      });
      queue.push({key:edge.from,depth:current.depth+1});
    }
  }

  const impacted=new Set([...initial,...steps.map((step)=>step.affected)]);
  const files:string[]=[];
  const symbols:string[]=[];
  const components:string[]=[];
  const config:string[]=[];
  const endpoints:string[]=[];
  const tests:string[]=[];
  const routes:string[]=[];
  const apiRoutes:string[]=[];

  for (const key of impacted) {
    const kind=reachedKinds.get(key);
    const file=moduleOf(key);
    if (looksLikeFile(file)) addUnique(files,file);
    if (key.includes("#")) addUnique(symbols,key);
    if (kind==="component") addUnique(components,key);
    if (kind==="config") addUnique(config,key);
    if (kind==="backend-endpoint") addUnique(endpoints,key);
  }

  // Affected symbols can expose further external effects without claiming that
  // those effects themselves depend on the seed.
  const seedKind=reachedKinds.get(seed);
  for (const edge of edges) {
    if (!impacted.has(edge.from)) continue;
    if (edge.type==="fetches"||edge.type==="delegates-to") addUnique(endpoints,edge.to);
    // When the changed seed is itself config, sibling reads of an affected
    // module are not additional affected config (e.g. next.config.ts reads
    // several independent keys). For file/symbol seeds these are useful
    // dependencies of the impacted surface.
    if (edge.type==="reads"&&seedKind!=="config") addUnique(config,edge.to);
    if (edge.type==="validated-by") addUnique(tests,edge.to);
  }

  for (const route of options.routes ?? []) {
    const routeAffected=impacted.has(route.route)||files.includes(route.sourceFile);
    if (!routeAffected) continue;
    addUnique(routes,route.route);
    if (route.routeType==="route-handler"||route.routeType==="api") addUnique(apiRoutes,route.route);
  }

  return {seed,steps,files,symbols,components,routes,apiRoutes,config,endpoints,tests,truncated};
}
