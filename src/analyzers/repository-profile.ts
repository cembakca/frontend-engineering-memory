import { access } from "node:fs/promises";
import path from "node:path";
import { readJson, readTextIfSmall } from "../utils/fs.js";
import type { RepositoryProfile, RouterType } from "../types.js";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  scripts?: Record<string, string>;
  packageManager?: string;
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

function packageManagerFromPackageJson(pkg: PackageJson): string | null {
  if (!pkg.packageManager) return null;
  return pkg.packageManager.split("@")[0] ?? null;
}

export async function analyzeRepositoryProfile(name: string, repoPath: string): Promise<RepositoryProfile> {
  const pkg = (await readJson<PackageJson>(path.join(repoPath, "package.json"))) ?? {};
  const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };

  const hasApp = await Promise.any([
    access(path.join(repoPath, "app")),
    access(path.join(repoPath, "src/app")),
  ].map((p) => p.then(() => true))).catch(() => false);
  const hasPages = await Promise.any([
    access(path.join(repoPath, "pages")),
    access(path.join(repoPath, "src/pages")),
  ].map((p) => p.then(() => true))).catch(() => false);

  let routerType: RouterType = "unknown";
  if (hasApp && hasPages) routerType = "hybrid";
  else if (hasApp) routerType = "app";
  else if (hasPages) routerType = "pages";

  let packageManager = packageManagerFromPackageJson(pkg);
  if (!packageManager) {
    if (await exists(path.join(repoPath, "pnpm-lock.yaml"))) packageManager = "pnpm";
    else if (await exists(path.join(repoPath, "yarn.lock"))) packageManager = "yarn";
    else if (await exists(path.join(repoPath, "package-lock.json"))) packageManager = "npm";
  }

  let outputMode: string | null = null;
  let nextConfigFile: string | null = null;
  for (const configName of ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs"]) {
    const raw = await readTextIfSmall(path.join(repoPath, configName));
    if (!raw) continue;
    if (/output\s*:\s*["']standalone["']/.test(raw)) outputMode = "standalone";
    else if (/output\s*:\s*["']export["']/.test(raw)) outputMode = "export";
    else outputMode = "default/custom";
    nextConfigFile = configName;
    break;
  }

  return {
    name,
    path: repoPath,
    framework: deps.next ? "Next.js" : "Unknown",
    nextVersion: deps.next ?? null,
    reactVersion: deps.react ?? null,
    nodeVersion: pkg.engines?.node ?? null,
    routerType,
    packageManager,
    buildCommand: pkg.scripts?.build ? `${packageManager ?? "npm"} run build` : null,
    startCommand: pkg.scripts?.start ? `${packageManager ?? "npm"} run start` : null,
    devCommand: pkg.scripts?.dev ? `${packageManager ?? "npm"} run dev` : null,
    outputMode,
    evidenceFiles: ["package.json",...(nextConfigFile ? [nextConfigFile] : [])],
  };
}
