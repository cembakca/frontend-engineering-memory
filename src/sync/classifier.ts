import type { AnalyzerKind, ClassifiedFile } from "../types.js";

function kinds(...values:AnalyzerKind[]):AnalyzerKind[]{ return [...new Set(values)]; }

export function classifyFile(filePath:string): ClassifiedFile {
  const file=filePath.replaceAll("\\","/");
  let analyzers:AnalyzerKind[]=[];
  if (/(^|\/)package\.json$|(?:pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$/.test(file)) analyzers=kinds("repository","build");
  else if (/(^|\/)next\.config\.(?:js|mjs|cjs|ts)$/.test(file)) analyzers=kinds("repository","route","configuration","build","security");
  else if (/(^|\/)(?:middleware|proxy)\.(?:ts|js)$/.test(file)) analyzers=kinds("middleware","authentication","route","security");
  else if (/(^|\/)(?:Dockerfile|docker-compose[^/]*|tsconfig\.json)$/.test(file)) analyzers=kinds("build","configuration");
  else if (/(^|\/)\.env(?:\.[^/]+)?$/.test(file)) analyzers=kinds("configuration","security");
  else if (/^(?:src\/)?app\/(?:.*\/)?(?:robots\.txt|sitemap\.xml|manifest\.webmanifest)$/.test(file)) analyzers=kinds("seo","configuration");
  else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file)) {
    analyzers=kinds("rendering","api","cache","authentication","state","seo","analytics","configuration","security","performance","technical-debt");
    if (/(^|\/)(?:app|pages)\//.test(file)) analyzers.push("route");
    if (/(^|\/)(?:services?|api|clients?|queries)\//.test(file)) analyzers.push("api");
    if (/(^|\/)providers?\//.test(file)) analyzers.push("state","authentication");
  }
  return {path:file,analyzers:kinds(...analyzers),memoryRelevant:analyzers.length>0};
}
