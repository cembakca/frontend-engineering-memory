import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authenticateWebhook, parseWebhook, WebhookError } from "../src/webhook.js";

const REGISTRY={repositories:[
  {name:"company.web.next",url:"git@gitlab.com:company/company.web.next.git",mainBranch:"main"},
  {name:"legacy.app",path:"/work/legacy.app",mainBranch:"master"},
]};

async function withRegistry<T>(run:()=>Promise<T>|T):Promise<T> {
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-webhook-"));
  const file=path.join(root,"repositories.json");
  await writeFile(file,JSON.stringify(REGISTRY));
  const previous=process.env.MEMORY_REPOSITORIES_FILE;
  process.env.MEMORY_REPOSITORIES_FILE=file;
  try { return await run(); }
  finally {
    if (previous===undefined) delete process.env.MEMORY_REPOSITORIES_FILE; else process.env.MEMORY_REPOSITORIES_FILE=previous;
    await rm(root,{recursive:true,force:true});
  }
}

function withSecret<T>(secret:string|undefined,run:()=>T):T {
  const previous=process.env.MEMORY_WEBHOOK_SECRET;
  if (secret===undefined) delete process.env.MEMORY_WEBHOOK_SECRET; else process.env.MEMORY_WEBHOOK_SECRET=secret;
  try { return run(); }
  finally { if (previous===undefined) delete process.env.MEMORY_WEBHOOK_SECRET; else process.env.MEMORY_WEBHOOK_SECRET=previous; }
}

const SHA="a".repeat(40);
const params=(value="")=>new URLSearchParams(value);

test("without a secret, accepts loopback and refuses the network",()=>{
  withSecret(undefined,()=>{
    authenticateWebhook({headers:{},rawBody:"",remoteAddress:"127.0.0.1"});
    authenticateWebhook({headers:{},rawBody:"",remoteAddress:"::ffff:127.0.0.1"});
    assert.throws(()=>authenticateWebhook({headers:{},rawBody:"",remoteAddress:"10.0.0.7"}),
      /MEMORY_WEBHOOK_SECRET/,"an unauthenticated endpoint must not be reachable from another host");
  });
});

test("accepts a GitLab token, a bearer token and a GitHub signature",()=>{
  withSecret("s3cret",()=>{
    const body=JSON.stringify({ref:"refs/heads/main"});
    authenticateWebhook({headers:{"x-gitlab-token":"s3cret"},rawBody:body,remoteAddress:"10.0.0.7"});
    authenticateWebhook({headers:{authorization:"Bearer s3cret"},rawBody:body,remoteAddress:"10.0.0.7"});
    authenticateWebhook({headers:{"x-memory-token":"s3cret"},rawBody:body,remoteAddress:"10.0.0.7"});
    const signature=`sha256=${createHmac("sha256","s3cret").update(body).digest("hex")}`;
    authenticateWebhook({headers:{"x-hub-signature-256":signature},rawBody:body,remoteAddress:"10.0.0.7"});
  });
});

test("refuses a wrong token, a wrong signature and a missing credential",()=>{
  withSecret("s3cret",()=>{
    const body=JSON.stringify({ref:"refs/heads/main"});
    assert.throws(()=>authenticateWebhook({headers:{"x-gitlab-token":"nope"},rawBody:body,remoteAddress:"10.0.0.7"}),/Invalid webhook token/);
    assert.throws(()=>authenticateWebhook({headers:{"x-hub-signature-256":"sha256=deadbeef"},rawBody:body,remoteAddress:"10.0.0.7"}),/Invalid webhook signature/);
    assert.throws(()=>authenticateWebhook({headers:{},rawBody:body,remoteAddress:"127.0.0.1"}),/Missing webhook credential/,
      "a secret, once set, is required even on loopback");
  });
});

test("matches a GitLab push to the repository by clone url alone",async()=>{
  await withRegistry(async()=>{
    const intent=await parseWebhook({
      object_kind:"push",ref:"refs/heads/main",after:SHA,
      project:{git_ssh_url:"git@gitlab.com:company/company.web.next.git"},
    },params());
    assert.equal(intent.repository,"company.web.next");
    assert.equal(intent.commit,SHA);
    assert.equal(intent.source,"gitlab");
  });
});

test("matches a GitHub push across the https form of the same remote",async()=>{
  await withRegistry(async()=>{
    const intent=await parseWebhook({
      ref:"refs/heads/main",head_commit:{id:SHA},pusher:{name:"ci"},
      repository:{clone_url:"https://gitlab.com/company/company.web.next.git"},
    },params());
    assert.equal(intent.repository,"company.web.next");
    assert.equal(intent.source,"github");
  });
});

test("accepts the plain shape a Jenkins job posts",async()=>{
  await withRegistry(async()=>{
    const intent=await parseWebhook({repository:"legacy.app",commit:SHA},params());
    assert.equal(intent.repository,"legacy.app");
    assert.equal(intent.source,"generic");
  });
});

test("skips a branch the repository is not indexed from",async()=>{
  await withRegistry(async()=>{
    await assert.rejects(()=>parseWebhook({ref:"refs/heads/feature/x",after:SHA,
      project:{git_ssh_url:"git@gitlab.com:company/company.web.next.git"}},params()),
      (error:unknown)=>error instanceof WebhookError&&error.status===202&&/indexed from main/.test(error.message));
  });
});

test("respects a non-default main branch",async()=>{
  await withRegistry(async()=>{
    const intent=await parseWebhook({repository:"legacy.app",commit:SHA,ref:"refs/heads/master"},params());
    assert.equal(intent.repository,"legacy.app");
    await assert.rejects(()=>parseWebhook({repository:"legacy.app",commit:SHA,ref:"refs/heads/main"},params()),
      /indexed from master/);
  });
});

test("refuses a short sha, a branch deletion and an unknown repository",async()=>{
  await withRegistry(async()=>{
    await assert.rejects(()=>parseWebhook({repository:"legacy.app",commit:"abc123"},params()),/40-character commit SHA/);
    await assert.rejects(()=>parseWebhook({repository:"legacy.app",commit:"0".repeat(40),ref:"refs/heads/master"},params()),
      /Branch deletion/,"a deleted branch names no commit to index");
    await assert.rejects(()=>parseWebhook({repository:"absent",commit:SHA},params()),/not registered/);
    await assert.rejects(()=>parseWebhook({commit:SHA,repository:{clone_url:"https://example.com/other.git"}},params()),
      /Could not match this payload/);
  });
});
