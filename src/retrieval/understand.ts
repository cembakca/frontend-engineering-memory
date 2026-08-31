import type { MemoryType, RetrievalQuery } from "../types.js";

const TYPE_TERMS:Array<[MemoryType,RegExp]> = [
  ["middleware",/\b(middleware|proxy|matcher)\b/i],
  ["authentication",/\b(auth|authentication|login|session|cookie|token)\b/i],
  ["cache",/\b(cache|revalidate|ttl|no-store|force-cache)\b/i],
  ["rendering",/\b(render|rendering|ssr|ssg|isr|rsc|csr|dynamic|static)\b/i],
  ["api_dependency",/\b(api|backend|endpoint|fetch|axios|graphql)\b/i],
  ["configuration",/\b(config|configuration|environment|env)\b/i],
  ["dependency",/\b(dependency|package|npm)\b/i],
  ["seo",/\b(seo|metadata|canonical|robots|sitemap)\b/i],
  ["security",/\b(security|csp|nonce|authorization)\b/i],
];

export function understandQuery(raw:string,options:{repo?:string;memoryTypes?:MemoryType[]}={}):RetrievalQuery {
  const nextMatch=raw.match(/Next(?:\.js)?\s*(?:version\s*)?(\d{1,2})/i);
  const routeMatch=raw.match(/(?:route|path)?\s*(\/(?:[\w@.()\[\]-]+\/?)+|\/)(?:\s|$|[?,.])/i);
  const memoryTypes=options.memoryTypes?.length ? options.memoryTypes : TYPE_TERMS.filter(([,pattern])=>pattern.test(raw)).map(([type])=>type);
  const channels:Array<"sql"|"fts"|"vector">=[];
  if (nextMatch || routeMatch || /\b(route|routes|repository|repositories|version)\b/i.test(raw)) channels.push("sql");
  channels.push("fts","vector");
  return {
    raw,
    repository:options.repo,
    memoryTypes:memoryTypes.length ? [...new Set(memoryTypes)] : undefined,
    nextMajor:nextMatch ? Number(nextMatch[1]) : undefined,
    route:routeMatch?.[1]?.replace(/\/$/,"") || (routeMatch?.[1]==="/" ? "/" : undefined),
    channels:[...new Set(channels)],
  };
}
