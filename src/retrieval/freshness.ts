import path from "node:path";
import { getRepositoryConfig, projectRoot } from "../config.js";
import { countCommitsBetween, getCommitTimestamp, getHeadSha, getWorkingTreeStatus, isGitRepository } from "../git/git.js";
import type { MemoryDatabase } from "../memory/database.js";
import { MemoryStore } from "../memory/store.js";
import { readJson } from "../utils/fs.js";

/**
 * RCE-026 freshness.
 *
 * Two different questions are kept apart on purpose:
 *  - snapshot freshness: does the index describe the current commit?
 *  - tree accuracy: does the current commit describe the files on disk?
 *
 * RCE-N03 failed because the engine answered the first and stayed silent about
 * the second. An indexed SHA equal to HEAD is not the same as "current".
 */
export type FreshnessState="fresh"|"tree-dirty"|"behind"|"diverged"|"never-indexed"|"unknown";

export interface FreshnessTargets {
  mergeToIndexedLagSeconds:{target:number;breach:number};
  reconciliationDriftCommits:{target:number;warn:number;breach:number};
}

export interface FreshnessReport {
  repository:string;
  state:FreshnessState;
  indexedSha:string|null;
  headSha:string|null;
  /** Commits on HEAD that the index has not seen. */
  driftCommits:number|null;
  /** Seconds between the indexed commit being authored and indexing completing. */
  mergeToIndexedLagSeconds:number|null;
  workingTreeDirty:boolean|null;
  dirtyFileCount:number|null;
  lastIndexedAt:string|null;
  slo:{
    lag:"met"|"warn"|"breach"|"unknown";
    drift:"met"|"warn"|"breach"|"unknown";
    overall:"met"|"warn"|"breach"|"unknown";
  };
  /** What an answer built on this snapshot must tell the reader. */
  answerGuidance:string;
  warnings:string[];
}

const DEFAULT_TARGETS:FreshnessTargets={
  mergeToIndexedLagSeconds:{target:900,breach:86_400},
  reconciliationDriftCommits:{target:0,warn:1,breach:10},
};

export async function loadFreshnessTargets(file?:string):Promise<FreshnessTargets> {
  const loaded=await readJson<any>(path.resolve(file ?? path.join(projectRoot(),"config/freshness-slo.json")));
  const lag=loaded?.targets?.mergeToIndexedLagSeconds;
  const drift=loaded?.targets?.reconciliationDriftCommits;
  return {
    mergeToIndexedLagSeconds:{
      target:Number(lag?.target ?? DEFAULT_TARGETS.mergeToIndexedLagSeconds.target),
      breach:Number(lag?.breach ?? DEFAULT_TARGETS.mergeToIndexedLagSeconds.breach),
    },
    reconciliationDriftCommits:{
      target:Number(drift?.target ?? DEFAULT_TARGETS.reconciliationDriftCommits.target),
      warn:Number(drift?.warn ?? DEFAULT_TARGETS.reconciliationDriftCommits.warn),
      breach:Number(drift?.breach ?? DEFAULT_TARGETS.reconciliationDriftCommits.breach),
    },
  };
}

function worst(...values:Array<"met"|"warn"|"breach"|"unknown">):"met"|"warn"|"breach"|"unknown" {
  if (values.includes("breach")) return "breach";
  if (values.includes("warn")) return "warn";
  if (values.includes("unknown")) return "unknown";
  return "met";
}

/** The sentence an answer must carry. Never claims currency the snapshot cannot support. */
function guidanceFor(state:FreshnessState,drift:number|null,dirtyFiles:number|null):string {
  switch (state) {
    case "fresh":
      return "Snapshot matches HEAD; facts describe the current commit.";
    case "tree-dirty":
      return `Snapshot matches HEAD, but ${dirtyFiles ?? "some"} file(s) are uncommitted. Facts describe the last commit, not the files on disk — verify against source before acting on them.`;
    case "behind":
      return `Snapshot is ${drift ?? "several"} commit(s) behind HEAD. Re-sync before treating these facts as current; anything touched by those commits may be wrong.`;
    case "diverged":
      return "Indexed commit is not an ancestor of HEAD; re-index before use.";
    case "never-indexed":
      return "Never indexed; no facts available, read the source.";
    default:
      return "Freshness unknown (repository unavailable); treat facts as unverified.";
  }
}

export async function evaluateFreshness(
  memoryDb:MemoryDatabase,
  repositoryName:string,
  targets?:FreshnessTargets,
):Promise<FreshnessReport> {
  const store=new MemoryStore(memoryDb);
  const row=store.getRepository(repositoryName);
  if (!row) throw new Error(`Repository not found: ${repositoryName}`);
  const limits=targets ?? await loadFreshnessTargets();

  const indexedSha=(row.last_indexed_sha as string|null) ?? null;
  const lastIndexedAt=(row.last_indexed_at as string|null) ?? null;
  const warnings:string[]=[];

  let repoPath:string|null=null;
  try { repoPath=(await getRepositoryConfig(repositoryName)).path; }
  catch (error) { warnings.push(`repository path unavailable: ${(error as Error).message}`); }

  let headSha:string|null=null;
  let driftCommits:number|null=null;
  let workingTreeDirty:boolean|null=null;
  let dirtyFileCount:number|null=null;
  let lagSeconds:number|null=null;

  if (repoPath&&await isGitRepository(repoPath)) {
    try {
      headSha=await getHeadSha(repoPath);
      const status=await getWorkingTreeStatus(repoPath);
      dirtyFileCount=status ? status.split(/\r?\n/).filter(Boolean).length : 0;
      workingTreeDirty=dirtyFileCount>0;
      if (indexedSha) {
        driftCommits=await countCommitsBetween(repoPath,indexedSha,headSha);
        const committedAt=await getCommitTimestamp(repoPath,indexedSha);
        if (committedAt!=null&&lastIndexedAt) {
          const indexedAtMs=Date.parse(`${lastIndexedAt.replace(" ","T")}Z`);
          if (Number.isFinite(indexedAtMs)) lagSeconds=Math.max(0,Math.round(indexedAtMs/1000-committedAt));
        }
      }
    } catch (error) { warnings.push(`git inspection failed: ${(error as Error).message}`); }
  } else if (repoPath) {
    warnings.push("path is not a Git repository; drift cannot be measured");
  }

  let state:FreshnessState;
  if (!indexedSha) state="never-indexed";
  else if (headSha==null) state="unknown";
  else if (driftCommits==null) state="diverged";
  else if (driftCommits>0) state="behind";
  else if (workingTreeDirty) state="tree-dirty";
  else state="fresh";

  const lagSlo:"met"|"warn"|"breach"|"unknown"=lagSeconds==null ? "unknown"
    : lagSeconds<=limits.mergeToIndexedLagSeconds.target ? "met"
    : lagSeconds>=limits.mergeToIndexedLagSeconds.breach ? "breach" : "warn";
  const driftSlo:"met"|"warn"|"breach"|"unknown"=driftCommits==null ? "unknown"
    : driftCommits<=limits.reconciliationDriftCommits.target ? "met"
    : driftCommits>=limits.reconciliationDriftCommits.breach ? "breach" : "warn";

  return {
    repository:repositoryName,
    state,
    indexedSha,
    headSha,
    driftCommits,
    mergeToIndexedLagSeconds:lagSeconds,
    workingTreeDirty,
    dirtyFileCount,
    lastIndexedAt,
    slo:{lag:lagSlo,drift:driftSlo,overall:worst(lagSlo,driftSlo)},
    answerGuidance:guidanceFor(state,driftCommits,dirtyFileCount),
    warnings,
  };
}

/**
 * Compact block attached to every context pack so no answer can omit its
 * freshness state. Null fields are dropped: an unmeasurable value carries no
 * information and this block competes with facts for the same budget.
 */
export function packFreshness(report:FreshnessReport):Record<string,unknown> {
  return {
    state:report.state,
    ...(report.indexedSha ? {indexedSha:report.indexedSha} : {}),
    ...(report.headSha&&report.headSha!==report.indexedSha ? {headSha:report.headSha} : {}),
    ...(report.driftCommits ? {driftCommits:report.driftCommits} : {}),
    ...(report.workingTreeDirty ? {dirtyFiles:report.dirtyFileCount ?? true} : {}),
    guidance:report.answerGuidance,
  };
}

/**
 * Freshness needs a `git` call, so it is cached briefly. The TTL is short on
 * purpose: drift changes without the snapshot changing, so caching by SHA would
 * hide exactly the condition this check exists to catch.
 */
export class FreshnessCache {
  private readonly entries=new Map<string,{at:number;report:FreshnessReport}>();
  constructor(private readonly memoryDb:MemoryDatabase,private readonly ttlMs=Number(process.env.MEMORY_FRESHNESS_TTL_MS ?? 15_000)) {}

  async get(repository:string):Promise<FreshnessReport|null> {
    const cached=this.entries.get(repository);
    if (cached&&Date.now()-cached.at<this.ttlMs) return cached.report;
    try {
      const report=await evaluateFreshness(this.memoryDb,repository);
      this.entries.set(repository,{at:Date.now(),report});
      return report;
    } catch { return null; }
  }
}
