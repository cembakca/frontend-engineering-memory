import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { assertRepositorySnapshot, changedFiles, getHeadSha } from "../src/git/git.js";

const exec = promisify(execFile);

async function git(root:string,args:string[]){ await exec("git",["-C",root,...args]); }

test("detects changed files between indexed SHA and new HEAD",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-git-"));
  try {
    await git(root,["init"]);
    await git(root,["config","user.email","test@example.com"]);
    await git(root,["config","user.name","Test"]);
    await writeFile(path.join(root,"a.ts"),"export const a=1;\n");
    await git(root,["add","."]); await git(root,["commit","-m","first"]);
    const first=await getHeadSha(root);
    await writeFile(path.join(root,"a.ts"),"export const a=2;\n");
    await writeFile(path.join(root,"b.ts"),"export const b=1;\n");
    await git(root,["add","."]); await git(root,["commit","-m","second"]);
    const second=await getHeadSha(root);
    const changes=await changedFiles(root,first,second);
    assert.deepEqual(changes.map((x)=>[x.status,x.path]),[["M","a.ts"],["A","b.ts"]]);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("rejects dirty, wrong-branch and mismatched Git snapshots",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-snapshot-"));
  try {
    await git(root,["init","-b","main"]);
    await git(root,["config","user.email","test@example.com"]);
    await git(root,["config","user.name","Test"]);
    await writeFile(path.join(root,"a.ts"),"export const a=1;\n");
    await git(root,["add","."]); await git(root,["commit","-m","first"]);
    const head=await getHeadSha(root);
    assert.equal(await assertRepositorySnapshot(root,"main",head),head);
    await assert.rejects(()=>assertRepositorySnapshot(root,"main","0000000000000000000000000000000000000000"),/does not match expected commit/);

    await writeFile(path.join(root,"a.ts"),"export const a=2;\n");
    await assert.rejects(()=>assertRepositorySnapshot(root,"main",head),/working tree must be clean/);
    await git(root,["restore","a.ts"]);
    await git(root,["checkout","-b","feature"]);
    await assert.rejects(()=>assertRepositorySnapshot(root,"main",head),/must be on main/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("allows detached CI snapshots only with the expected commit",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-detached-"));
  try {
    await git(root,["init","-b","main"]);
    await git(root,["config","user.email","test@example.com"]);
    await git(root,["config","user.name","Test"]);
    await writeFile(path.join(root,"a.ts"),"export const a=1;\n");
    await git(root,["add","."]); await git(root,["commit","-m","first"]);
    const head=await getHeadSha(root);
    await git(root,["checkout","--detach",head]);
    await assert.rejects(()=>assertRepositorySnapshot(root,"main"),/Detached HEAD requires/);
    assert.equal(await assertRepositorySnapshot(root,"main",head),head);
  } finally { await rm(root,{recursive:true,force:true}); }
});
