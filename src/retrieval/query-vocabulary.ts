export type QueryAliases=Record<string,string[]>;

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

/** Resolve a matched vocabulary group to a real static route identity. */
export function matchingAliasRoute(raw:string,groups:QueryAliases[],routes:string[]):string|undefined {
  const terms=matchingQueryAliases(raw,groups).map(fold);
  if (!terms.length) return undefined;
  const candidates=routes.filter((route)=>!route.includes("[")).map((route)=>({
    route,
    path:fold(route.replace(/^\//,"")),
    segments:route.split("/").filter(Boolean).map(fold),
  }));
  return candidates.find((candidate)=>terms.includes(candidate.path))?.route
    ?? candidates.find((candidate)=>candidate.segments.some((segment)=>terms.includes(segment)))?.route;
}
