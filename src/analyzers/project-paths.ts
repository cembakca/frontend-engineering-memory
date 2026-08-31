import path from "node:path";
import { readTextIfSmall } from "../utils/fs.js";

export async function generatedOutputPaths(repoPath:string):Promise<Set<string>> {
  const ignored=new Set<string>();
  for (const file of ["next.config.ts","next.config.js","next.config.mjs","next.config.cjs"]) {
    const content=await readTextIfSmall(path.join(repoPath,file));
    if (!content) continue;
    for (const match of content.matchAll(/\bdistDir\s*:\s*["']([^"']+)["']/g)) {
      const value=(match[1] ?? "").replaceAll("\\","/").replace(/^\.\//,"").replace(/\/$/,"");
      if (value && value!=="." && !value.startsWith("../") && !path.posix.isAbsolute(value)) ignored.add(value);
    }
  }
  return ignored;
}
