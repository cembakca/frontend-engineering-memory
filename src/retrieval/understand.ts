import type { MemoryType, RetrievalQuery } from "../types.js";
import { classifyTaskIntent } from "./intent.js";
import { routeLookupKey } from "./route-identity.js";

const TYPE_TERMS:Array<[MemoryType,RegExp]> = [
  ["middleware",/\b(middleware|proxy|matcher)\b/i],
  ["authentication",/\b(auth|authentication|login|session|cookie|token)\b/i],
  ["authorization",/\b(authoriz(?:e|ation)|permission|role|forbidden|unauthorized|yetki|izin|rol)\b/i],
  ["cache",/\b(cache|revalidate|ttl|no-store|force-cache)\b/i],
  ["cache_invalidation",/\b(invalidate|invalidation|revalidateTag|updateTag|revalidatePath|cache tag)\b/i],
  ["server_function",/\b(server action|server function|use server)\b/i],
  ["rendering",/\b(render|rendering|ssr|ssg|isr|rsc|csr|dynamic|static)\b/i],
  ["api_dependency",/\b(api|backend|endpoint|fetch|axios|graphql)\b/i],
  ["configuration",/\b(config|configuration|environment|env)\b/i],
  ["dependency",/\b(dependency|package|npm)\b/i],
  ["seo",/\b(seo|metadata|canonical|robots|sitemap)\b/i],
  ["special_file",/\b(loading|template|not-found|global-error|forbidden|unauthorized|robots|sitemap|manifest|opengraph-image|twitter-image)\b/i],
  ["next_config",/\b(next\.config|rewrite|redirects?|headers|basePath|assetPrefix|transpilePackages)\b/i],
  ["schema_contract",/\b(schema|validation|zod|yup|valibot|formdata|payload|form field)\b/i],
  ["analytics_event",/\b(?:analytics\s+event\w*|tracking\s+event\w*|gtag|dataLayer|trackEvent|event\s+payload)\b/i],
  ["security",/\b(security|csp|nonce|authorization)\b/i],
  ["error_handling",/\b(error|failed|failure|hata|4\d\d|5\d\d)\b/i],
  ["module_contract",/\b(contract|registry|adapter|provider|pattern)\b/i],
];

function extractHttpRoute(raw:string):string|undefined {
  for (const match of raw.matchAll(/\/(?:[\p{L}\p{N}_@.%()\[\]-]+\/?)*\/??/gu)) {
    const index=match.index ?? 0;
    const before=index ? raw[index-1] : undefined;
    const after=raw[index+match[0].length];
    if (before?.match(/[\w/:]/)||after==="/") continue;
    if (/\.[cm]?[jt]sx?$|\.json$/i.test(match[0])) continue;
    return routeLookupKey(match[0]);
  }
  return undefined;
}

export function understandQuery(raw:string,options:{repo?:string;memoryTypes?:MemoryType[]}={}):RetrievalQuery {
  const nextMatch=raw.match(/Next(?:\.js)?\s*(?:version\s*)?(\d{1,2})/i);
  const route=extractHttpRoute(raw);
  const classified=classifyTaskIntent(raw);
  let memoryTypes=options.memoryTypes?.length ? options.memoryTypes : TYPE_TERMS.filter(([,pattern])=>pattern.test(raw)).map(([type])=>type);
  if (!options.memoryTypes?.length&&memoryTypes.includes("analytics_event")&&!/\b(schema|validation|zod|yup|valibot|formdata|form payload|json payload)\b/i.test(raw)) {
    memoryTypes=memoryTypes.filter((type)=>type!=="schema_contract");
  }
  const channels:Array<"sql"|"fts"|"vector">=[];
  if (nextMatch || route || /\b(route|routes|repository|repositories|version)\b/i.test(raw)) channels.push("sql");
  channels.push("fts","vector");
  return {
    raw,
    repository:options.repo,
    memoryTypes:memoryTypes.length ? [...new Set(memoryTypes)] : undefined,
    nextMajor:nextMatch ? Number(nextMatch[1]) : undefined,
    route,
    intent:classified.intent,
    intentConfidence:classified.confidence,
    channels:[...new Set(channels)],
  };
}
