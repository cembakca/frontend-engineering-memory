import path from "node:path";
import { readJson } from "../utils/fs.js";
import type { DependencyCandidate } from "../types.js";
import { readTextIfSmall } from "../utils/fs.js";
import { listAnalyzableSourceFiles } from "./source-memory.js";
import { extractSourceFacts } from "./source-facts.js";

interface PackageJson { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; }

const CATEGORY_RULES: Array<[RegExp, string, string]> = [
  [/^(next|react|react-dom)$/, "framework/runtime", "Frontend framework/runtime"],
  [/(@tanstack\/react-query|react-query|swr|axios|ky|graphql|@apollo\/client)/, "data-fetching", "Data fetching / client data layer"],
  [/(redux|zustand|jotai|mobx|recoil)/, "state-management", "Shared/global state management"],
  [/(tailwind|styled-components|@emotion|sass|vanilla-extract)/, "styling", "Styling infrastructure"],
  [/(next-auth|@auth\/|jsonwebtoken|jose)/, "authentication", "Authentication/session infrastructure"],
  [/(jest|vitest|playwright|cypress|testing-library|storybook)/, "testing", "Testing/development tooling"],
  [/(google-analytics|gtag|gtm|segment|adobe|analytics)/i, "analytics", "Analytics/tracking"],
];

function isInternalPackage(name:string,version:string,prefixes:string[]):boolean {
  return /^(?:workspace:|file:|link:)/.test(version)||prefixes.some((prefix)=>prefix&&name.startsWith(prefix));
}

function classify(name:string,version:string,internalPackagePrefixes:string[]): { category: string; purpose: string } | null {
  if (isInternalPackage(name,version,internalPackagePrefixes)) return { category: "internal-package", purpose: "Internal company package" };
  for (const [regex, category, purpose] of CATEGORY_RULES) {
    if (regex.test(name)) return { category, purpose };
  }
  return null;
}

export async function analyzePackageDependencies(repoPath:string,internalPackagePrefixes:string[]=[]): Promise<DependencyCandidate[]> {
  const pkg = (await readJson<PackageJson>(path.join(repoPath, "package.json"))) ?? {};
  const merged = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
  return Object.entries(merged).flatMap(([name,version]) => {
    const c = classify(name,version,internalPackagePrefixes);
    if (!c) return [];
    return [{
      dependencyType: isInternalPackage(name,version,internalPackagePrefixes) ? "internal-package" as const : "npm" as const,
      name,
      category: c.category,
      purpose: c.purpose,
      runtime: "mixed" as const,
      sourceFile: "package.json",
    }];
  });
}

export async function analyzeRepositoryDependencies(repoPath:string,internalPackagePrefixes:string[]=[]):Promise<DependencyCandidate[]> {
  const dependencies=await analyzePackageDependencies(repoPath,internalPackagePrefixes);
  const packageNames=new Set(dependencies.map((dependency)=>dependency.name));
  const seen=new Set(dependencies.map((dependency)=>`${dependency.dependencyType}\0${dependency.name}\0${dependency.sourceFile}`));
  const push=(candidate:DependencyCandidate):void=>{
    const key=`${candidate.dependencyType}\0${candidate.name}\0${candidate.sourceFile}`;
    if (!seen.has(key)) { seen.add(key); dependencies.push(candidate); }
  };
  for (const sourceFile of await listAnalyzableSourceFiles(repoPath)) {
    const content=await readTextIfSmall(path.join(repoPath,sourceFile));
    if (content==null) continue;
    const facts=extractSourceFacts(sourceFile,content,{internalPackagePrefixes});
    for (const signal of facts.dataSources) {
      push({dependencyType:"http",name:signal.value,category:"backend-api",purpose:`${signal.kind} data source`,runtime:"unknown",sourceFile,sourceSymbol:signal.symbol,startLine:signal.line});
    }
    for (const signal of facts.envKeys) {
      push({dependencyType:"config",name:signal.value,category:"configuration",purpose:"Runtime configuration key",runtime:"mixed",configKey:signal.value,sourceFile,sourceSymbol:signal.symbol,startLine:signal.line});
    }
    for (const signal of facts.internalPackages) {
      if (packageNames.has(signal.value)) continue;
      packageNames.add(signal.value);
      push({dependencyType:"internal-package",name:signal.value,category:"internal-package",purpose:"Internal company package",runtime:"mixed",sourceFile,sourceSymbol:signal.symbol,startLine:signal.line});
    }
  }
  return dependencies;
}
