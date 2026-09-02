export type QueryAliases=Record<string,string[]>;

interface VocabularyRoute {
  route:string;
  sourceFile:string;
  dataSources?:string[];
  backendDependencies?:string[];
  clientBoundaries?:string[];
}

const MAX_GROUPS=100;
const MAX_ALIASES_PER_GROUP=20;
const MAX_TERM_LENGTH=80;

function fold(value:string):string {
  return value.toLocaleLowerCase("tr-TR").normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
    .replaceAll("ı","i").replaceAll("ş","s").replaceAll("ğ","g").replaceAll("ç","c").replaceAll("ö","o").replaceAll("ü","u")
    .replace(/[^a-z0-9_@./\[\]-]+/g," ").trim().replace(/\s+/g," ");
}

function validTerm(value:unknown):value is string {
  return typeof value==="string"&&value.trim().length>=2&&value.trim().length<=MAX_TERM_LENGTH;
}

/** Validate local registry input before it becomes part of every retrieval. */
export function normalizeQueryAliases(value:unknown):QueryAliases {
  if (value==null) return {};
  if (typeof value!=="object"||Array.isArray(value)) throw new Error("queryAliases must be an object of vocabulary groups");
  const entries=Object.entries(value).slice(0,MAX_GROUPS);
  const normalized:QueryAliases={};
  for (const [canonical,aliases] of entries) {
    if (!validTerm(canonical)) throw new Error(`Invalid queryAliases key: ${canonical}`);
    if (!Array.isArray(aliases)||aliases.some((item)=>!validTerm(item))) {
      throw new Error(`queryAliases.${canonical} must be an array of 2-${MAX_TERM_LENGTH} character strings`);
    }
    normalized[canonical.trim()]=[...new Set(aliases.slice(0,MAX_ALIASES_PER_GROUP).map((item)=>item.trim()))];
  }
  return normalized;
}

function readable(value:string):string {
  return value.replace(/([a-z0-9])([A-Z])/g,"$1 $2").replace(/[-_]+/g," ").replace(/\s+/g," ").trim();
}

export interface VocabularyRewrite {
  source:string;
  destination:string|null;
}

/** Path parameters and wildcards carry no vocabulary: `/kredi/:type` → `/kredi`. */
function staticPrefix(value:string):string {
  // Rule values arrive as source text, so a string literal still carries quotes.
  const literal=value.trim().replace(/^['"`]|['"`]$/g,"");
  const path=literal.split("?")[0]!.replace(/^https?:\/\/[^/]+/,"");
  const segments:string[]=[];
  for (const segment of path.split("/")) {
    if (!segment) continue;
    if (segment.startsWith(":")||segment.includes("*")||segment.includes("[")||segment.includes("(")) break;
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/**
 * Public URLs are the words people use for a page. A project whose internal
 * route is `/loan/housingloan` commonly serves it at a localized public path
 * (`/kredi/konut-kredisi`) declared in its rewrite rules, and that mapping is
 * the repository's own evidence for what the page is called — no hand-curated
 * alias list required.
 */
function rewriteAliases(routes:VocabularyRoute[],rewrites:VocabularyRewrite[]):Map<string,string[]> {
  const byRoute=new Map<string,string[]>();
  const known=new Set(routes.map((route)=>fold(route.route)));
  for (const rule of rewrites) {
    if (!rule.destination) continue;
    const destination=staticPrefix(rule.destination);
    const publicPath=staticPrefix(rule.source);
    if (destination==="/"||publicPath==="/"||!known.has(fold(destination))) continue;
    if (fold(publicPath)===fold(destination)) continue;
    const key=publicPath.replace(/^\//,"");
    const terms=[key,readable(key.replaceAll("/"," ")),...key.split("/").filter((item)=>item.length>=3)
      .flatMap((item)=>[item,readable(item)])];
    byRoute.set(destination,[...new Set([...(byRoute.get(destination) ?? []),...terms])]);
  }
  return byRoute;
}

/** Build code-side vocabulary without requiring registry-side alias curation. */
export function deriveQueryAliases(routes:VocabularyRoute[],configured:unknown,rewrites:VocabularyRewrite[]=[]):QueryAliases {
  const generated:QueryAliases={...normalizeQueryAliases(configured)};
  const publicPaths=rewriteAliases(routes,rewrites);
  for (const route of routes) {
    if (Object.keys(generated).length>=MAX_GROUPS) break;
    if (route.route.includes("[")) continue;
    const pathKey=route.route.replace(/^\//,"");
    if (pathKey.length<2||pathKey.length>MAX_TERM_LENGTH) continue;
    const canonical=readable(pathKey.replaceAll("/"," "));
    const segments=pathKey.split("/").filter((item)=>item.length>=2);
    const candidates=[pathKey,...segments,...(publicPaths.get(route.route) ?? []),
      ...(route.dataSources ?? []),...(route.backendDependencies ?? []),...(route.clientBoundaries ?? [])]
      .flatMap((item)=>[item,readable(item)])
      .map((item)=>item.trim()).filter((item)=>validTerm(item)&&item!==canonical);
    const aliases=[...new Set(candidates)].slice(0,MAX_ALIASES_PER_GROUP);
    if (aliases.length) {
      generated[canonical]=[...new Set([...(generated[canonical] ?? []),...aliases])].slice(0,MAX_ALIASES_PER_GROUP);
    }
  }
  return normalizeQueryAliases(generated);
}

/**
 * Total question text a group's mentioned terms cover. Terms contained in a
 * longer mentioned term of the same group are not counted twice, so a group
 * does not win by repeating one phrase in several forms.
 */
function mentionCoverage(mentioned:string[]):number {
  const folded=[...new Set(mentioned.map(fold))].sort((a,b)=>b.length-a.length);
  const kept:string[]=[];
  for (const term of folded) if (!kept.some((longer)=>longer.includes(term))) kept.push(term);
  return kept.reduce((sum,term)=>sum+term.length,0);
}

function containsPhrase(query:string,phrase:string):boolean {
  if (!phrase) return false;
  return ` ${query} `.includes(` ${phrase} `);
}

/**
 * Expand only a vocabulary group explicitly mentioned by the user. This keeps
 * product aliases useful without injecting every repository term into every
 * query. Keys and values are symmetric: either side may be the user's wording.
 */
export function matchingQueryAliases(raw:string,groups:QueryAliases[]):string[] {
  const query=fold(raw);
  const expanded:string[]=[];
  for (const group of groups) {
    for (const [canonical,aliases] of Object.entries(group)) {
      const terms=[canonical,...aliases];
      if (!terms.some((term)=>containsPhrase(query,fold(term)))) continue;
      expanded.push(...terms);
    }
  }
  const seen=new Set<string>();
  return expanded.filter((term)=>{
    const key=fold(term);
    if (!key||seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface AliasRouteMatch {
  route:string;
  /** Longest mentioned vocabulary term, in folded characters. */
  strength:number;
  /** Whether the user named the group's canonical wording rather than a derived fragment. */
  canonicalMentioned:boolean;
}

/**
 * Resolve a matched vocabulary group to a real static route identity, and say
 * how strong the match was. Derived vocabulary contains generic fragments
 * ("api", "auth", "form"), so a caller that acts on the route rather than
 * merely boosting it must be able to require a specific mention.
 */
export function aliasRouteMatch(raw:string,groups:QueryAliases[],routes:string[]):AliasRouteMatch|undefined {
  const query=fold(raw);
  const directGroups=groups.flatMap((group)=>Object.entries(group).map(([canonical,aliases])=>{
    const terms=[canonical,...aliases];
    const mentioned=terms.filter((term)=>containsPhrase(query,fold(term)));
    return {canonical,terms,mentioned,canonicalMentioned:containsPhrase(query,fold(canonical))};
  })).filter((group)=>group.mentioned.length);
  const candidates=routes.filter((route)=>!route.includes("[")).map((route)=>({
    route,
    path:fold(route.replace(/^\//,"")),
    readablePath:fold(route.replace(/^\//,"").replace(/[-_/]+/g," ")),
    segments:route.split("/").filter(Boolean).map(fold),
  }));
  const direct=directGroups.flatMap((group)=>{
    const canonical=fold(group.canonical);
    const route=candidates.find((candidate)=>candidate.path===canonical||candidate.readablePath===canonical)
      ?? candidates.find((candidate)=>candidate.segments.includes(canonical));
    if (!route) return [];
    const longestMention=Math.max(...group.mentioned.map((term)=>fold(term).length));
    // How much of the question the group explains, not just its longest single
    // term: `/loan/consumer` and `/loan/consumer/list` both answer to "ihtiyaç
    // kredisi", and only the deeper group also answers to "sorgulama".
    const coverage=mentionCoverage(group.mentioned);
    return [{route:route.route,strength:longestMention,canonicalMentioned:group.canonicalMentioned,
      score:(group.canonicalMentioned ? 10_000 : 0)+(group.mentioned.some((term)=>fold(term)===query) ? 5_000 : 0)+coverage}];
  }).sort((a,b)=>b.score-a.score||a.route.localeCompare(b.route));
  if (direct[0]) return {route:direct[0].route,strength:direct[0].strength,canonicalMentioned:direct[0].canonicalMentioned};

  const terms=matchingQueryAliases(raw,groups).map(fold);
  if (!terms.length) return undefined;
  const fallback=candidates.find((candidate)=>terms.includes(candidate.path))
    ?? candidates.find((candidate)=>candidate.segments.some((segment)=>terms.includes(segment)));
  if (!fallback) return undefined;
  const mentioned=terms.filter((term)=>containsPhrase(query,term));
  return {route:fallback.route,strength:mentioned.length ? Math.max(...mentioned.map((term)=>term.length)) : 0,
    canonicalMentioned:false};
}

/** Route identity only, for callers that do not need the match strength. */
export function matchingAliasRoute(raw:string,groups:QueryAliases[],routes:string[]):string|undefined {
  return aliasRouteMatch(raw,groups,routes)?.route;
}
