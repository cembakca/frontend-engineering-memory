import { readdir } from "node:fs/promises";
import path from "node:path";
import { readTextIfSmall } from "../utils/fs.js";
import type { DependencyCandidate, MemoryCandidate } from "../types.js";

export async function listProjectAnalysisFiles(repoPath:string):Promise<string[]> {
  let names:string[]=[];
  try { names=await readdir(repoPath); } catch { return []; }
  return names.filter((name)=>
    /^Dockerfile(?:\..+)?$/.test(name) ||
    /^docker-compose.*\.ya?ml$/.test(name) ||
    /^next\.config\.(?:ts|js|mjs|cjs)$/.test(name) ||
    /^tsconfig\.json$/.test(name) ||
    /^\.env(?:\..+)?$/.test(name),
  ).sort();
}

export async function analyzeProjectFile(repoPath:string,sourceFile:string):Promise<MemoryCandidate[]> {
  const content=await readTextIfSmall(path.join(repoPath,sourceFile),1_000_000);
  if (content==null) return [];
  const out:MemoryCandidate[]=[];
  if (/^Dockerfile/.test(sourceFile) || /^docker-compose/.test(sourceFile)) {
    const bases=[...content.matchAll(/^FROM\s+([^\s]+)/gm)].map((match)=>match[1]).filter(Boolean);
    out.push({type:"build",subject:sourceFile,content:`${sourceFile} defines container build/runtime${bases.length ? ` with base images ${bases.join(", ")}` : ""}.`,confidence:"verified",sourceFile,startLine:1,endLine:content.split("\n").length});
  }
  if (sourceFile==="tsconfig.json") {
    out.push({type:"build",subject:sourceFile,content:`${sourceFile} defines TypeScript compiler and module-resolution configuration.`,confidence:"verified",sourceFile,startLine:1,endLine:content.split("\n").length});
  }
  if (/^\.env/.test(sourceFile)) {
    for (const match of content.matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gm)) {
      out.push({type:"configuration",subject:match[1]!,content:`${sourceFile} declares configuration key ${match[1]}.`,confidence:"verified",sourceFile,startLine:content.slice(0,match.index ?? 0).split("\n").length});
    }
  }
  return out;
}

export function dependencyMemories(dependencies:DependencyCandidate[]):MemoryCandidate[] {
  return dependencies.map((dependency)=>({
    type:"dependency",
    subject:`${dependency.dependencyType}:${dependency.name}`,
    content:`${dependency.name} is recorded as ${dependency.dependencyType} dependency (${dependency.category})${dependency.purpose ? ` for ${dependency.purpose}` : ""}.`,
    confidence:"verified",
    sourceFile:dependency.sourceFile,
    sourceSymbol:dependency.sourceSymbol,
    startLine:dependency.startLine,
  }));
}
