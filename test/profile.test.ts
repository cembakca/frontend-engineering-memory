import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeRepositoryProfile } from "../src/analyzers/repository-profile.js";

test("detects Next.js versions, package manager and hybrid router",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-profile-"));
  try {
    await writeFile(path.join(root,"package.json"),JSON.stringify({
      dependencies:{next:"15.5.0",react:"19.1.0"},
      engines:{node:">=20"},
      scripts:{dev:"next dev",build:"next build",start:"next start"},
      packageManager:"pnpm@10.0.0"
    }));
    await mkdir(path.join(root,"src/app"),{recursive:true});
    await mkdir(path.join(root,"pages"),{recursive:true});
    await writeFile(path.join(root,"next.config.js"),"module.exports={output:'standalone'};\n");
    const profile=await analyzeRepositoryProfile("repo",root);
    assert.equal(profile.routerType,"hybrid");
    assert.equal(profile.nextVersion,"15.5.0");
    assert.equal(profile.packageManager,"pnpm");
    assert.equal(profile.outputMode,"standalone");
  } finally { await rm(root,{recursive:true,force:true}); }
});
