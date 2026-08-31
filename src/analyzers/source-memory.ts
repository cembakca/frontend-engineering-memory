import path from "node:path";
import { walkFiles } from "../utils/walk.js";
import { lineNumberAt, readTextIfSmall } from "../utils/fs.js";
import type { MemoryCandidate } from "../types.js";
import { enrichEvidence, extractSourceFacts } from "./source-facts.js";
import { generatedOutputPaths } from "./project-paths.js";

export async function listAnalyzableSourceFiles(repoPath: string): Promise<string[]> {
  return walkFiles(repoPath, { ignoredPaths:await generatedOutputPaths(repoPath),include: (file) => !file.endsWith(".d.ts") });
}

function push(candidates: MemoryCandidate[], candidate: MemoryCandidate): void {
  if (!candidates.some((x) => x.type === candidate.type && x.subject === candidate.subject && x.content === candidate.content)) {
    candidates.push(candidate);
  }
}

function firstLine(content: string, regex: RegExp): number | null {
  const match = regex.exec(content);
  return match ? lineNumberAt(content, match.index) : null;
}

export async function analyzeSourceFile(repoPath: string, sourceFile: string): Promise<MemoryCandidate[]> {
  const content = await readTextIfSmall(path.join(repoPath, sourceFile));
  if (!content) return [];
  const out: MemoryCandidate[] = [];
  const facts=extractSourceFacts(sourceFile,content);

  for (const signal of facts.envKeys) {
    const key=signal.value;
    push(out, {
      type: "configuration",
      subject: key,
      content: `Configuration key ${key} is referenced by ${sourceFile}.`,
      confidence: "verified",
      sourceFile,
      startLine: signal.line,
      endLine: signal.endLine,
      sourceSymbol: signal.symbol,
    });
  }

  for (const signal of facts.internalPackages) {
    const pkg=signal.value;
    push(out, {
      type: pkg.includes("component") || pkg.includes("token") ? "design_system" : "shared_package",
      subject: pkg,
      content: `${sourceFile} imports internal package ${pkg}.`,
      confidence: "verified",
      sourceFile,
      startLine:signal.line,
      endLine:signal.endLine,
      sourceSymbol:signal.symbol,
    });
  }

  if (/\b(?:cookies|headers)\s*\(/.test(content)) {
    const functions = ["cookies", "headers"].filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(content));
    push(out, {
      type: "rendering",
      subject: sourceFile,
      content: `${sourceFile} uses ${functions.map((f) => `${f}()`).join(" and ")}; this is a request-specific server runtime signal in Next.js.`,
      confidence: "verified",
      sourceFile,
      startLine: firstLine(content, /\b(?:cookies|headers)\s*\(/),
    });
  }

  if (/cache\s*:\s*["']no-store["']/.test(content)) {
    push(out, {
      type: "cache",
      subject: sourceFile,
      content: `${sourceFile} contains a fetch configured with cache: 'no-store'.`,
      confidence: "verified",
      sourceFile,
      startLine: firstLine(content, /cache\s*:\s*["']no-store["']/),
    });
  }
  if (/cache\s*:\s*["']force-cache["']/.test(content)) {
    push(out, {
      type: "cache",
      subject: sourceFile,
      content: `${sourceFile} contains a fetch configured with cache: 'force-cache'.`,
      confidence: "verified",
      sourceFile,
      startLine: firstLine(content, /cache\s*:\s*["']force-cache["']/),
    });
  }

  for (const match of content.matchAll(/\brevalidate\s*[:=]\s*(\d+)/g)) {
    push(out, {
      type: "cache",
      subject: sourceFile,
      content: `${sourceFile} defines a revalidate value of ${match[1]} seconds.`,
      confidence: "verified",
      sourceFile,
      startLine: lineNumberAt(content, match.index ?? 0),
    });
  }

  const authTokens = ["access_token", "refresh_token", "userInfo", "isLoggedIn"].filter((token) => content.includes(token));
  if (authTokens.length) {
    push(out, {
      type: "authentication",
      subject: sourceFile,
      content: `${sourceFile} references authentication/session signals: ${authTokens.join(", ")}.`,
      confidence: "verified",
      sourceFile,
    });
  }

  if (/(?:middleware|proxy)\.(?:ts|js)$/.test(sourceFile)) {
    const hasMatcher = /matcher\s*:/.test(content);
    const actions = [
      /NextResponse\.redirect/.test(content) ? "redirect" : null,
      /NextResponse\.rewrite/.test(content) ? "rewrite" : null,
      /cookies?\b|\.cookies\b/.test(content) ? "cookie access" : null,
      /headers?\b|\.headers\b/.test(content) ? "header access/manipulation" : null,
    ].filter(Boolean);
    push(out, {
      type: "middleware",
      subject: sourceFile,
      content: `Next.js middleware is present in ${sourceFile}${hasMatcher ? " with matcher configuration" : ""}${actions.length ? `; detected behaviors: ${actions.join(", ")}` : ""}.`,
      confidence: "verified",
      sourceFile,
    });
  }

  if (/\bgenerateMetadata\b/.test(content) || /\bexport\s+const\s+metadata\b/.test(content)) {
    push(out, {
      type: "seo",
      subject: sourceFile,
      content: `${sourceFile} defines Next.js metadata using ${/\bgenerateMetadata\b/.test(content) ? "generateMetadata" : "static metadata"}.`,
      confidence: "verified",
      sourceFile,
    });
  }

  if (/dataLayer|gtag\s*\(|GoogleTagManager|GoogleAnalytics/i.test(content)) {
    push(out, {
      type: "analytics",
      subject: sourceFile,
      content: `${sourceFile} contains analytics/tracking integration code.`,
      confidence: "verified",
      sourceFile,
    });
  }

  for (const signal of facts.dataSources.slice(0,30)) {
    const target=signal.value;
    push(out, {
      type: "api_dependency",
      subject: `${sourceFile}:${signal.line}`,
      content: `${sourceFile} performs a ${signal.kind} data call with target ${target}.`,
      confidence: "verified",
      sourceFile,
      sourceSymbol:signal.symbol,
      startLine:signal.line,
      endLine:signal.endLine,
    });
  }

  if (/\b(useQuery|useMutation|QueryClient|HydrationBoundary|dehydrate)\b/.test(content)) {
    const signals = ["useQuery", "useMutation", "QueryClient", "HydrationBoundary", "dehydrate"].filter((s) => content.includes(s));
    push(out, {
      type: "data_fetching",
      subject: sourceFile,
      content: `${sourceFile} uses TanStack/React Query signals: ${signals.join(", ")}.`,
      confidence: "verified",
      sourceFile,
    });
  }

  const todos = [...content.matchAll(/\b(TODO|FIXME)\b[:\s-]*([^\n]{0,160})/g)].slice(0, 5);
  for (const match of todos) {
    push(out, {
      type: "technical_debt",
      subject: `${sourceFile}:${lineNumberAt(content, match.index ?? 0)}`,
      content: `${match[1]} in ${sourceFile}: ${(match[2] ?? "").trim() || "No description"}`,
      confidence: "verified",
      sourceFile,
      startLine: lineNumberAt(content, match.index ?? 0),
    });
  }

  for (const signal of facts.stateLibraries) {
    push(out,{type:"state_management",subject:signal.value,content:`${sourceFile} uses ${signal.value} for application state management.`,confidence:"verified",sourceFile,sourceSymbol:signal.symbol,startLine:signal.line,endLine:signal.endLine});
  }
  if (/(^|\/)(?:global-)?error\.(?:ts|tsx|js|jsx)$|(^|\/)not-found\.(?:ts|tsx|js|jsx)$/.test(sourceFile)) {
    push(out,{type:"error_handling",subject:sourceFile,content:`${sourceFile} implements a Next.js error or not-found boundary.`,confidence:"verified",sourceFile,startLine:1});
  }
  for (const signal of facts.securitySignals) {
    push(out,{type:"security",subject:`${sourceFile}:${signal.line}`,content:`${sourceFile} contains verified security-related code: ${signal.value}.`,confidence:"verified",sourceFile,sourceSymbol:signal.symbol,startLine:signal.line,endLine:signal.endLine});
  }
  for (const signal of facts.performanceSignals) {
    push(out,{type:"performance_observation",subject:`${sourceFile}:${signal.line}`,content:`${sourceFile} contains performance-related pattern ${signal.value}.`,confidence:"verified",sourceFile,sourceSymbol:signal.symbol,startLine:signal.line,endLine:signal.endLine});
  }
  for (const signal of facts.businessRules) {
    push(out,{type:"business_rule",subject:`${sourceFile}:${signal.line}`,content:`Explicit source annotation BUSINESS_RULE: ${signal.value}`,confidence:"verified",sourceFile,sourceSymbol:signal.symbol,startLine:signal.line,endLine:signal.endLine});
  }
  if (/(^|\/)(?:app|pages)\/(?:.+\/)?(?:page|route)\.(?:ts|tsx|js|jsx)$|(^|\/)pages\/(?!_)[^/]+\.(?:ts|tsx|js|jsx)$/.test(sourceFile)) {
    push(out,{type:"business_capability",subject:sourceFile,content:`${sourceFile} exposes a user-facing page or route-handler capability; no unverified business purpose is inferred.`,confidence:"verified",sourceFile,startLine:1});
  }
  if (/(^|\/)next\.config\.(?:ts|js|mjs|cjs)$/.test(sourceFile)) {
    push(out,{type:"build",subject:sourceFile,content:`${sourceFile} configures the Next.js build/runtime.`,confidence:"verified",sourceFile,startLine:1});
  }

  for (const candidate of out) {
    if (!candidate.startLine || (candidate.sourceSymbol && candidate.endLine)) continue;
    const evidence=enrichEvidence(sourceFile,content,candidate.startLine);
    candidate.sourceSymbol ??= evidence.symbol;
    candidate.endLine ??= evidence.endLine;
  }

  return out;
}
