import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ensureManagedCheckout, getRemoteUrl, refreshManagedCheckout, sameRemote } from "../src/git/git.js";
import { resolveRepositoryConfig } from "../src/config.js";

const run=promisify(execFile);
const env={...process.env,GIT_AUTHOR_NAME:"t",GIT_AUTHOR_EMAIL:"t@example.com",
  GIT_COMMITTER_NAME:"t",GIT_COMMITTER_EMAIL:"t@example.com"};
const git=(cwd:string,args:string[])=>run("git",["-C",cwd,...args],{env}).then((r)=>r.stdout.trim());

/** A bare repository standing in for GitHub or GitLab. */
async function origin(root:string,name="upstream"):Promise<string> {
  const work=path.join(root,`${name}-work`);
  const bare=path.join(root,`${name}.git`);
  await mkdir(work,{recursive:true});
  await run("git",["init","-q","-b","main",work],{env});
  await writeFile(path.join(work,"README.md"),"one\n");
  await git(work,["add","."]);
  await git(work,["commit","-q","-m","first"]);
  await run("git",["clone","-q","--bare",work,bare],{env});
  // The work tree pushes into the bare repository, so a test can move upstream.
  await git(work,["remote","add","origin",bare]);
  return bare;
}

test("derives a workspace path for a repository defined only by url",()=>{
  const config=resolveRepositoryConfig({name:"acme.web",url:"git@github.com:acme/web.git"});
  assert.ok(path.isAbsolute(config.path));
  assert.equal(path.basename(config.path),"acme.web");
  assert.equal(config.managedCheckout,true,"a clone URL means the engine owns the checkout");
  assert.equal(config.remote,"origin");
  assert.equal(config.mainBranch,"main");
});

test("keeps an explicit path and leaves an unmanaged folder unmanaged",()=>{
  const config=resolveRepositoryConfig({name:"local",path:"../local-checkout"});
  assert.equal(path.basename(config.path),"local-checkout");
  assert.equal(config.managedCheckout,false,"a folder the engine did not clone is never reset");
});

test("refuses a registry entry with neither path nor url",()=>{
  assert.throws(()=>resolveRepositoryConfig({name:"nowhere"}),/needs either a path or a url/);
});

test("clones a repository that is not on disk yet, then reuses it",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-clone-"));
  try {
    const url=await origin(root);
    const target=path.join(root,"workspace","acme.web");

    assert.equal(await ensureManagedCheckout(target,url,"main"),"cloned");
    assert.ok((await readdir(target)).includes("README.md"));
    assert.equal(await ensureManagedCheckout(target,url,"main"),"reused","a second sync must not re-clone");
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("refuses a checkout that points at a different repository",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-wrong-"));
  try {
    const first=await origin(root,"first");
    const second=await origin(root,"second");
    const target=path.join(root,"workspace","acme.web");
    await ensureManagedCheckout(target,first,"main");
    await assert.rejects(()=>ensureManagedCheckout(target,second,"main"),/points at/,
      "indexing the wrong repository silently would be worse than failing");
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("refuses to clone into a non-empty directory", async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-occupied-"));
  try {
    const url=await origin(root);
    const target=path.join(root,"occupied");
    await mkdir(target,{recursive:true});
    await writeFile(path.join(target,"notes.txt"),"someone else's work\n");
    await assert.rejects(()=>ensureManagedCheckout(target,url,"main"),/non-empty directory/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("pulls upstream commits on refresh and discards local drift",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-refresh-"));
  try {
    const url=await origin(root);
    const target=path.join(root,"workspace","acme.web");
    await ensureManagedCheckout(target,url,"main");
    const before=await git(target,["rev-parse","HEAD"]);

    // Someone pushes upstream.
    const work=path.join(root,"upstream-work");
    await writeFile(path.join(work,"README.md"),"one\ntwo\n");
    await git(work,["commit","-qam","second"]);
    await git(work,["push","-q","origin","main"]);

    await refreshManagedCheckout(target,"main");
    const after=await git(target,["rev-parse","HEAD"]);
    assert.notEqual(after,before,"the managed checkout follows the remote");
    assert.equal(await git(target,["status","--porcelain"]),"","and lands clean");
    assert.ok(sameRemote((await getRemoteUrl(target))!,url));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("treats ssh and https forms of the same remote as the same repository",()=>{
  assert.equal(sameRemote("git@github.com:acme/web.git","https://github.com/acme/web"),true);
  assert.equal(sameRemote("https://token@gitlab.com/acme/web.git","https://gitlab.com/acme/web/"),true);
  assert.equal(sameRemote("git@github.com:acme/web.git","git@github.com:acme/other.git"),false);
});
