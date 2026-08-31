import path from "node:path";
import { access } from "node:fs/promises";
import { walkFiles } from "../utils/walk.js";
import { readTextIfSmall } from "../utils/fs.js";
import type { RenderingMode, RouteRecord } from "../types.js";
import { LocalModuleGraph } from "./module-graph.js";
import { extractSourceFacts } from "./source-facts.js";
import { analyzeMiddleware, middlewareMatches } from "./middleware.js";
import { generatedOutputPaths } from "./project-paths.js";


function normalizeRoute(route: string): string {
  const normalized = `/${route}`.replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized === "" ? "/" : normalized;
}

function appUrlSegments(segments: string[]): string[] {
  const url: string[] = [];
  for (const segment of segments) {
    if (/^\(.*\)$/.test(segment)) continue; // route group
    if (segment.startsWith("@")) continue; // parallel route slot

    const rootIntercept = segment.match(/^\(\.\.\.\)(.*)$/);
    if (rootIntercept) {
      url.length = 0;
      if (rootIntercept[1]) url.push(rootIntercept[1]);
      continue;
    }

    const sameLevelIntercept = segment.match(/^\(\.\)(.*)$/);
    if (sameLevelIntercept) {
      if (sameLevelIntercept[1]) url.push(sameLevelIntercept[1]);
      continue;
    }

    const parentIntercept = segment.match(/^((?:\(\.\.\))+)(.*)$/);
    if (parentIntercept) {
      const levels = parentIntercept[1]!.match(/\(\.\.\)/g)?.length ?? 0;
      url.splice(Math.max(0,url.length-levels),levels);
      if (parentIntercept[2]) url.push(parentIntercept[2]);
      continue;
    }

    url.push(segment);
  }
  return url;
}

function appRouteFromRelative(relative: string): { route: string; type: RouteRecord["routeType"] } | null {
  const parts = relative.split("/");
  const file = parts.at(-1) ?? "";
  const base = file.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, "");
  if (base !== "page" && base !== "route") return null;
  const segments = appUrlSegments(parts.slice(0, -1));
  return { route: normalizeRoute(segments.join("/")), type: base === "route" ? "route-handler" : "page" };
}

function pagesRouteFromRelative(relative: string): { route: string; type: RouteRecord["routeType"] } | null {
  const withoutExt = relative.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, "");
  const segments = withoutExt.split("/");
  const file = segments.at(-1) ?? "";
  if (["_app", "_document", "_error"].includes(file)) return null;
  if (segments[0] === "api") {
    const apiSegments = [...segments];
    if (apiSegments.at(-1) === "index") apiSegments.pop();
    return { route: normalizeRoute(apiSegments.join("/")), type: "api" };
  }
  if (file === "404" || file === "500") return { route: `/${file}`, type: "special" };
  if (segments.at(-1) === "index") segments.pop();
  return { route: normalizeRoute(segments.join("/")), type: "page" };
}

function detectRendering(content: string, router: "app" | "pages"): { mode: RenderingMode; evidence: string[]; defaulted?: boolean } {
  const evidence: string[] = [];
  if (router === "pages") {
    if (/\bgetServerSideProps\b/.test(content)) return { mode: "ssr", evidence: ["getServerSideProps"] };
    if (/\bgetStaticProps\b/.test(content)) {
      if (/\brevalidate\s*:/.test(content)) return { mode: "isr", evidence: ["getStaticProps", "revalidate"] };
      return { mode: "ssg", evidence: ["getStaticProps"] };
    }
    if (/dynamic\s*\([^)]*\{[\s\S]*?ssr\s*:\s*false/.test(content)) return { mode: "csr", evidence: ["dynamic(..., { ssr: false })"] };
    return { mode: "unknown", evidence, defaulted: true };
  }

  if (/^[\s\S]*?["']use client["']\s*;?/m.test(content)) {
    evidence.push('"use client"');
  }
  if (/\bexport\s+const\s+dynamic\s*=\s*["']force-dynamic["']/.test(content)) {
    evidence.push("dynamic=force-dynamic");
    return { mode: "dynamic-ssr", evidence };
  }
  if (/\b(?:cookies|headers|draftMode|connection)\s*\(/.test(content)) {
    for (const fn of ["cookies", "headers", "draftMode", "connection"]) {
      if (new RegExp(`\\b${fn}\\s*\\(`).test(content)) evidence.push(`${fn}()`);
    }
    return { mode: "dynamic-ssr", evidence };
  }
  if (/cache\s*:\s*["']no-store["']/.test(content)) {
    evidence.push("fetch cache=no-store");
    return { mode: "dynamic-ssr", evidence };
  }
  if (/\bexport\s+const\s+revalidate\s*=\s*\d+/.test(content) || /next\s*:\s*\{[\s\S]*?revalidate\s*:/.test(content)) {
    evidence.push("revalidate");
    return { mode: "isr", evidence };
  }
  if (/\bexport\s+const\s+dynamic\s*=\s*["']force-static["']/.test(content) || /cache\s*:\s*["']force-cache["']/.test(content)) {
    evidence.push("explicit static/cache signal");
    return { mode: "static", evidence };
  }
  if (/^[\s\S]*?["']use client["']\s*;?/m.test(content)) return { mode: "csr", evidence };
  return { mode: "rsc", evidence: ["App Router page without detected dynamic trigger"], defaulted: true };
}

function renderingPriority(mode: RenderingMode): number {
  return ({ unknown:0, rsc:1, csr:1, static:2, ssg:2, isr:3, ssr:4, "dynamic-ssr":5, hybrid:5 })[mode];
}

function mergeRendering(current: RenderingMode, candidate: RenderingMode): RenderingMode {
  return renderingPriority(candidate) > renderingPriority(current) ? candidate : current;
}

function detectMetadata(content: string): RouteRecord["metadataMode"] {
  if (/\b(?:async\s+)?function\s+generateMetadata\b|\bexport\s+(?:async\s+)?function\s+generateMetadata\b|\bexport\s+const\s+generateMetadata\b/.test(content)) return "dynamic";
  if (/\bexport\s+const\s+metadata\b/.test(content)) return "static";
  return "none";
}


async function existingLayout(repoPath: string, dir: string): Promise<string | null> {
  for (const ext of ["tsx", "ts", "jsx", "js", "mjs", "cjs"]) {
    const relative = `${dir}/layout.${ext}`.replace(/^\//, "");
    try { await access(path.join(repoPath, relative)); return relative; } catch {}
  }
  return null;
}

async function layoutChainFor(repoPath: string, sourceFile: string, router: "app" | "pages"): Promise<string[]> {
  if (router === "pages") {
    const prefix = sourceFile.startsWith("src/pages/") ? "src/pages" : "pages";
    for (const ext of ["tsx", "ts", "jsx", "js"]) {
      const candidate = `${prefix}/_app.${ext}`;
      try { await access(path.join(repoPath, candidate)); return [candidate]; } catch {}
    }
    return [];
  }
  const appRoot = sourceFile.startsWith("src/app/") ? "src/app" : "app";
  const dir = path.posix.dirname(sourceFile);
  const rel = path.posix.relative(appRoot, dir);
  const parts = !rel || rel === "." ? [] : rel.split("/");
  const chain: string[] = [];
  for (let i = 0; i <= parts.length; i++) {
    const d = [appRoot, ...parts.slice(0, i)].join("/");
    const layout = await existingLayout(repoPath, d);
    if (layout) chain.push(layout);
  }
  return chain;
}

async function fileMetadataSource(repoPath:string,sourceFile:string,layoutChain:string[]):Promise<string|null> {
  const dirs=[path.posix.dirname(sourceFile),...layoutChain.map((file)=>path.posix.dirname(file)).reverse()];
  const bases=["opengraph-image","twitter-image","icon","apple-icon","sitemap","robots","manifest"];
  const extensions=["ts","tsx","js","jsx","png","jpg","jpeg","svg","ico","xml","txt","webmanifest","json"];
  for (const dir of dirs) for (const base of bases) for (const ext of extensions) {
    const candidate=`${dir}/${base}.${ext}`;
    try { await access(path.join(repoPath,candidate)); return candidate; } catch {}
  }
  return null;
}

function routeParams(route: string): string[] {
  return [...route.matchAll(/\[+([^\]]+)\]+/g)].map((m) => m[1]!.replace(/^\.\.\./, ""));
}

export async function scanRoutes(repoPath: string): Promise<RouteRecord[]> {
  const moduleGraph = await LocalModuleGraph.create(repoPath);
  const middleware=await analyzeMiddleware(repoPath);
  const ignoredPaths=await generatedOutputPaths(repoPath);
  const files = await walkFiles(repoPath, {
    ignoredPaths,
    include: (file) => {
      if (file.startsWith("app/") || file.startsWith("src/app/")) {
        return /\/(?:page|route)\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(file);
      }
      return file.startsWith("pages/") || file.startsWith("src/pages/");
    },
  });
  const routes: RouteRecord[] = [];

  for (const sourceFile of files.sort()) {
    const appPrefix = sourceFile.startsWith("src/app/") ? "src/app/" : sourceFile.startsWith("app/") ? "app/" : null;
    const pagesPrefix = sourceFile.startsWith("src/pages/") ? "src/pages/" : sourceFile.startsWith("pages/") ? "pages/" : null;
    if (!appPrefix && !pagesPrefix) continue;

    const parsed = appPrefix
      ? appRouteFromRelative(sourceFile.slice(appPrefix.length))
      : pagesRouteFromRelative(sourceFile.slice(pagesPrefix!.length));
    if (!parsed) continue;

    const content = (await readTextIfSmall(path.join(repoPath, sourceFile))) ?? "";
    const routerType = appPrefix ? "app" : "pages";
    const layoutChain = await layoutChainFor(repoPath, sourceFile, routerType);
    const behaviorFiles = await moduleGraph.reachableFrom([sourceFile,...layoutChain]);
    const ownRendering = detectRendering(content,routerType);
    const ownFacts = extractSourceFacts(sourceFile,content);
    const segmentConfig = ownFacts.segmentConfig;
    const controlFlow = ownFacts.controlFlow.map((signal)=>({kind:signal.kind,target:signal.target,conditional:signal.conditional}));
    // A page whose body always redirects never renders, so no helper signal can
    // describe it. Control flow outranks rendering classification.
    const alwaysRedirects = controlFlow.some((signal)=>signal.kind!=="not-found"&&!signal.conditional);
    // `export const dynamic` / `revalidate` are the framework's own authority for
    // this segment; a signal found in a reachable helper cannot override them.
    const hasDirective = Boolean(segmentConfig.dynamic||segmentConfig.revalidate);
    let renderingMode = ownRendering.mode;
    let renderingBasis:RouteRecord["renderingBasis"] = alwaysRedirects ? "observed"
      : hasDirective ? "directive"
      : ownRendering.defaulted ? "default" : "observed";
    const evidence = ownRendering.evidence.map((item) => `${sourceFile}: ${item}`);
    for (const signal of ownFacts.controlFlow) {
      evidence.push(`${sourceFile}:${signal.line}: ${signal.kind}${signal.target ? ` -> ${signal.target}` : ""}${signal.conditional ? " (conditional)" : ""}`);
    }
    for (const [key,value] of Object.entries(segmentConfig)) evidence.push(`${sourceFile}: export const ${key} = ${value}`);
    let authSignal = /\b(access_token|refresh_token|isLoggedIn|session|auth(?:entication|orization)?)\b/i.test(content);
    const clientBoundaries:string[]=[];
    const dataSources:string[]=[];
    const backendDependencies:string[]=[];
    const cacheBehavior:string[]=[];
    const dependencies:RouteRecord["dependencies"]=[];

    for (const behaviorFile of behaviorFiles) {
      const behaviorContent = (await readTextIfSmall(path.join(repoPath,behaviorFile))) ?? "";
      const facts=extractSourceFacts(behaviorFile,behaviorContent);
      if (facts.clientBoundary) clientBoundaries.push(behaviorFile);
      for (const signal of facts.dataSources) {
        dataSources.push(signal.value);
        backendDependencies.push(signal.value);
        dependencies.push({dependencyType:"http",name:signal.value,usageType:signal.kind==="fetch" ? "data-fetching" : "api-call",sourceFile:behaviorFile,sourceSymbol:signal.symbol,startLine:signal.line});
      }
      for (const signal of facts.envKeys) dependencies.push({dependencyType:"config",name:signal.value,usageType:"configuration",sourceFile:behaviorFile,sourceSymbol:signal.symbol,startLine:signal.line});
      for (const signal of facts.internalPackages) dependencies.push({dependencyType:"internal-package",name:signal.value,usageType:"internal-package",sourceFile:behaviorFile,sourceSymbol:signal.symbol,startLine:signal.line});
      cacheBehavior.push(...facts.cacheBehavior.map((signal)=>`${behaviorFile}: ${signal.value}`));
      if (behaviorFile === sourceFile) continue;
      const behaviorRendering = detectRendering(behaviorContent,routerType);
      // A nested client boundary does not make the whole route CSR, but dynamic server APIs
      // and cache/revalidation signals in reachable modules affect the route.
      // Reachability is not contribution: a helper cannot re-classify a route that
      // redirects unconditionally or that declares its own segment config.
      if (!alwaysRedirects && !hasDirective
        && behaviorRendering.mode !== "csr" && behaviorRendering.mode !== "rsc" && behaviorRendering.mode !== "unknown") {
        const merged = mergeRendering(renderingMode,behaviorRendering.mode);
        if (merged !== renderingMode) renderingBasis = "inherited";
        renderingMode = merged;
        evidence.push(...behaviorRendering.evidence.map((item) => `${behaviorFile}: ${item}`));
      }
      if (/\b(access_token|refresh_token|isLoggedIn|session|auth(?:entication|orization)?)\b/i.test(behaviorContent)) authSignal = true;
    }

    let metadataMode = detectMetadata(content);
    let metadataSource:string|null=metadataMode!=="none" ? sourceFile : null;
    if (metadataMode === "none") {
      for (const layoutFile of [...layoutChain].reverse()) {
        const layoutContent = (await readTextIfSmall(path.join(repoPath,layoutFile))) ?? "";
        const inherited = detectMetadata(layoutContent);
        if (inherited !== "none") { metadataMode = inherited; metadataSource=layoutFile; break; }
      }
    }
    const fileMetadata=await fileMetadataSource(repoPath,sourceFile,layoutChain);
    const seoType=fileMetadata ? "file-based" : metadataMode;
    if (fileMetadata) metadataSource=fileMetadata;
    const matched=middlewareMatches(parsed.route,middleware);
    if (matched && middleware?.authSignal) authSignal=true;
    const routeBehaviorFiles=[...new Set([
      ...behaviorFiles,
      ...(metadataSource ? [metadataSource] : []),
      ...(matched && middleware ? [middleware.sourceFile] : []),
    ])];

    routes.push({
      route: parsed.route,
      routeType: parsed.type,
      routerType,
      sourceFile,
      layoutChain,
      renderingMode,
      dynamicRoute: /\[/.test(parsed.route),
      routeParams: routeParams(parsed.route),
      authRequired: authSignal ? true : null,
      middlewareMatched: matched,
      metadataMode,
      serverComponent:routerType==="app" ? !/^\s*["']use client["']/m.test(content) : null,
      clientBoundaries:[...new Set(clientBoundaries)],
      dataSources:[...new Set(dataSources)],
      backendDependencies:[...new Set(backendDependencies)],
      cacheBehavior:[...new Set(cacheBehavior)],
      seoType,
      metadataSource,
      middlewareMatchers:matched ? middleware?.matchers ?? [] : [],
      evidence: [...new Set(evidence)],
      segmentConfig,
      controlFlow,
      renderingBasis,
      behaviorFiles:routeBehaviorFiles,
      dependencies:dependencies.filter((dependency,index,all)=>all.findIndex((item)=>item.dependencyType===dependency.dependencyType && item.name===dependency.name && item.sourceFile===dependency.sourceFile && item.usageType===dependency.usageType)===index),
    });
  }

  return routes;
}
