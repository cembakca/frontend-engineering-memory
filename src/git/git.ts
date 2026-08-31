import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChangedFile } from "../types.js";

const execFileAsync = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function getHeadSha(repoPath: string): Promise<string> {
  return git(repoPath, ["rev-parse", "HEAD"]);
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  return git(repoPath, ["branch", "--show-current"]);
}

export async function getWorkingTreeStatus(repoPath: string): Promise<string> {
  return git(repoPath,["status","--porcelain"]);
}

export async function isAncestor(repoPath: string, ancestorSha: string, descendantSha: string): Promise<boolean> {
  try {
    await git(repoPath,["merge-base","--is-ancestor",ancestorSha,descendantSha]);
    return true;
  } catch {
    return false;
  }
}

export async function assertRepositorySnapshot(repoPath: string, mainBranch: string, expectedCommit?: string): Promise<string> {
  const [head,branch,dirty] = await Promise.all([
    getHeadSha(repoPath),
    getCurrentBranch(repoPath),
    getWorkingTreeStatus(repoPath),
  ]);
  if (dirty) throw new Error(`Repository working tree must be clean before indexing: ${repoPath}`);
  if (branch && branch !== mainBranch) {
    throw new Error(`Repository must be on ${mainBranch}; current branch is ${branch}: ${repoPath}`);
  }
  if (!branch && !expectedCommit) {
    throw new Error(`Detached HEAD requires an explicit expected commit: ${repoPath}`);
  }
  if (expectedCommit && head !== expectedCommit) {
    throw new Error(`Repository HEAD ${head} does not match expected commit ${expectedCommit}: ${repoPath}`);
  }
  return head;
}

export async function isGitRepository(repoPath: string): Promise<boolean> {
  try {
    return (await git(repoPath, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

export async function changedFiles(repoPath: string, fromSha: string, toSha: string): Promise<ChangedFile[]> {
  const out = await git(repoPath, ["diff", "--name-status", "-M", `${fromSha}..${toSha}`]);
  if (!out) return [];
  return out.split("\n").flatMap((line) => {
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (!status) return [];
    if (status.startsWith("R") && parts[1] && parts[2]) {
      return [{ status, previousPath: parts[1], path: parts[2] }];
    }
    if (!parts[1]) return [];
    return [{ status, path: parts[1] }];
  });
}

export async function refreshManagedCheckout(repoPath: string, branch: string, remote = "origin"): Promise<void> {
  const dirty = await git(repoPath, ["status", "--porcelain"]);
  if (dirty) throw new Error(`Managed checkout is dirty; refusing destructive refresh: ${repoPath}`);
  await git(repoPath, ["fetch", "--prune", remote, branch]);
  try { await git(repoPath, ["checkout", "-q", branch]); }
  catch { await git(repoPath, ["checkout", "-q", "-B", branch, `${remote}/${branch}`]); }
  await git(repoPath, ["reset", "--hard", `${remote}/${branch}`]);
}
