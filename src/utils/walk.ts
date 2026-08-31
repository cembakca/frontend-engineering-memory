import { readdir } from "node:fs/promises";
import path from "node:path";

const DEFAULT_IGNORED_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", ".git"]);

export async function walkFiles(root: string, options: {
  extensions?: Set<string>;
  ignoredDirs?: Set<string>;
  ignoredPaths?: Set<string>;
  include?: (relativePath: string) => boolean;
} = {}): Promise<string[]> {
  const extensions = options.extensions ?? new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
  const ignoredDirs = options.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
  const ignoredPaths = options.ignoredPaths ?? new Set<string>();
  const out: string[] = [];

  async function visit(absDir: string): Promise<void> {
    let entries;
    try { entries = await readdir(absDir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
      const abs = path.join(absDir, entry.name);
      const relEntry = path.relative(root,abs).split(path.sep).join("/");
      if (entry.isDirectory() && ignoredPaths.has(relEntry)) continue;
      if (entry.isDirectory()) { await visit(abs); continue; }
      if (!entry.isFile()) continue;
      if (!extensions.has(path.extname(entry.name))) continue;
      const rel = relEntry;
      if (!options.include || options.include(rel)) out.push(rel);
    }
  }

  await visit(root);
  return out.sort();
}
