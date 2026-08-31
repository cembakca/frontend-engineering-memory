import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RepositoryConfig, RepositoryRegistry } from "./types.js";

const PROJECT_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");

function loadLocalEnvironment():void {
  try {
    const content=readFileSync(path.join(PROJECT_ROOT,".env"),"utf8");
    for (const line of content.split(/\r?\n/)) {
      const match=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]!]!==undefined) continue;
      let value=match[2] ?? "";
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value=value.slice(1,-1);
      process.env[match[1]!]=value;
    }
  } catch {}
}

loadLocalEnvironment();

export function projectRoot(): string {
  return PROJECT_ROOT;
}

export function dbPath(): string {
  const configured=process.env.MEMORY_DB_PATH;
  return configured ? (path.isAbsolute(configured) ? configured : path.resolve(PROJECT_ROOT,configured)) : path.join(PROJECT_ROOT,"data/engineering-memory.sqlite");
}

export function registryPath(): string {
  const configured=process.env.MEMORY_REPOSITORIES_FILE;
  return configured ? (path.isAbsolute(configured) ? configured : path.resolve(PROJECT_ROOT,configured)) : path.join(PROJECT_ROOT,"config/repositories.json");
}

export async function loadRegistry(): Promise<RepositoryRegistry> {
  const file = registryPath();
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw) as RepositoryRegistry;
  if (!parsed || !Array.isArray(parsed.repositories)) {
    throw new Error(`Invalid repository registry: ${file}`);
  }
  return parsed;
}

export async function getRepositoryConfig(name: string): Promise<RepositoryConfig> {
  const registry = await loadRegistry();
  const repo = registry.repositories.find((item) => item.name === name);
  if (!repo) throw new Error(`Repository not found in ${registryPath()}: ${name}`);
  return { ...repo, path: path.isAbsolute(repo.path) ? repo.path : path.resolve(PROJECT_ROOT,repo.path), mainBranch: repo.mainBranch ?? "main" };
}

export function embeddingsEnabled(): boolean {
  return (process.env.MEMORY_EMBEDDINGS_ENABLED ?? "1") !== "0";
}
