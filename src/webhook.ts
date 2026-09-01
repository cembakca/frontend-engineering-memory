import { createHmac, timingSafeEqual } from "node:crypto";
import { loadRegistry, resolveRepositoryConfig } from "./config.js";
import { sameRemote } from "./git/git.js";

/**
 * Webhook intake for CI and Git hosts.
 *
 * Parsing, authentication and repository resolution live here so the HTTP layer
 * stays a router. Two rules drive the design:
 *
 *  - A request that cannot be authenticated is refused rather than trusted
 *    because it looks well-formed. Indexing is a write.
 *  - The commit is taken from the payload, never from the repository's current
 *    head, so a webhook can never index something the sender did not name.
 */
export type WebhookSource="generic"|"gitlab"|"github";

export interface WebhookAuthContext {
  headers:Record<string,string|string[]|undefined>;
  rawBody:string;
  remoteAddress:string|undefined;
}

export interface WebhookIntent {
  repository:string;
  commit:string;
  ref:string|null;
  source:WebhookSource;
}

export class WebhookError extends Error {
  constructor(message:string,readonly status:number) { super(message); }
}

function header(headers:WebhookAuthContext["headers"],name:string):string|undefined {
  const value=headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function equals(a:string,b:string):boolean {
  const left=Buffer.from(a);
  const right=Buffer.from(b);
  return left.length===right.length&&timingSafeEqual(left,right);
}

function isLoopback(address:string|undefined):boolean {
  if (!address) return false;
  const normalized=address.replace(/^::ffff:/,"");
  return normalized==="127.0.0.1"||normalized==="::1"||normalized==="localhost";
}

/**
 * Verifies the caller.
 *
 * With `MEMORY_WEBHOOK_SECRET` set, a matching GitLab token or GitHub HMAC
 * signature is required. Without it, only loopback callers are accepted — an
 * unauthenticated endpoint reachable from the network would let anyone queue
 * indexing work.
 */
export function authenticateWebhook(context:WebhookAuthContext):void {
  const secret=process.env.MEMORY_WEBHOOK_SECRET;
  if (!secret) {
    if (isLoopback(context.remoteAddress)) return;
    throw new WebhookError("Set MEMORY_WEBHOOK_SECRET before accepting webhooks from other hosts",401);
  }

  const gitlabToken=header(context.headers,"x-gitlab-token");
  if (gitlabToken) {
    if (!equals(gitlabToken,secret)) throw new WebhookError("Invalid webhook token",401);
    return;
  }

  const githubSignature=header(context.headers,"x-hub-signature-256");
  if (githubSignature) {
    const expected=`sha256=${createHmac("sha256",secret).update(context.rawBody).digest("hex")}`;
    if (!equals(githubSignature,expected)) throw new WebhookError("Invalid webhook signature",401);
    return;
  }

  const bearer=header(context.headers,"authorization");
  const token=header(context.headers,"x-memory-token") ?? (bearer?.startsWith("Bearer ") ? bearer.slice(7) : undefined);
  if (!token) throw new WebhookError("Missing webhook credential",401);
  if (!equals(token,secret)) throw new WebhookError("Invalid webhook token",401);
}

function branchOf(ref:string|null):string|null {
  if (!ref) return null;
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/** Clone URLs a Git host may put in a push payload. */
function payloadRemotes(payload:any):string[] {
  return [
    payload?.repository?.git_ssh_url,payload?.repository?.git_http_url,payload?.repository?.url,
    payload?.repository?.ssh_url,payload?.repository?.clone_url,payload?.repository?.html_url,
    payload?.project?.git_ssh_url,payload?.project?.git_http_url,payload?.project?.web_url,
  ].filter((value):value is string=>typeof value==="string"&&value.length>0);
}

/**
 * Resolves a push payload into one repository and one commit.
 *
 * The repository is matched by registry name first, then by clone URL, so a Git
 * host webhook needs no knowledge of the names this service uses.
 */
export async function parseWebhook(payload:any,query:URLSearchParams):Promise<WebhookIntent> {
  if (!payload||typeof payload!=="object") throw new WebhookError("A JSON body is required",400);

  const source:WebhookSource=payload.object_kind==="push"||payload.project ? "gitlab"
    : payload.head_commit||payload.pusher ? "github" : "generic";

  const ref:string|null=payload.ref ?? null;
  const commit:string|undefined=payload.commit ?? payload.after ?? payload.checkout_sha
    ?? payload.head_commit?.id ?? query.get("commit") ?? undefined;
  if (typeof commit!=="string"||!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new WebhookError("A full 40-character commit SHA is required",400);
  }
  // GitLab sends this for a deleted branch; there is nothing to index.
  if (/^0{40}$/.test(commit)) throw new WebhookError("Branch deletion carries no commit to index",422);

  const registry=await loadRegistry();
  const requested=payload.repository_name ?? payload.repository ?? query.get("repository");
  const named=typeof requested==="string" ? requested : undefined;

  let entry=named ? registry.repositories.find((item)=>item.name===named) : undefined;
  if (!entry) {
    const remotes=payloadRemotes(payload);
    entry=registry.repositories.find((item)=>item.url&&remotes.some((remote)=>sameRemote(item.url!,remote)));
  }
  if (!entry) {
    throw new WebhookError(named
      ? `Repository not registered: ${named}`
      : "Could not match this payload to a registered repository; add its clone url to the registry or send repository explicitly",404);
  }

  const config=resolveRepositoryConfig(entry);
  const branch=branchOf(ref);
  if (branch&&branch!==config.mainBranch) {
    throw new WebhookError(`Ignoring ${branch}; ${config.name} is indexed from ${config.mainBranch}`,202);
  }

  return {repository:config.name,commit,ref,source};
}
