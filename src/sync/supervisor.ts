import { watch, type FSWatcher } from "node:fs";
import { loadRegistry, registryPath, resolveRepositoryConfig } from "../config.js";
import type { MemoryDatabase } from "../memory/database.js";
import { MemoryStore } from "../memory/store.js";
import { fullIndex, incrementalSync } from "./sync.js";

/**
 * Keeps the index in step with `config/repositories.json`.
 *
 * The registry is meant to be the only file a person edits, so every other
 * consequence of editing it is handled here: a new entry is indexed, a removed
 * entry is retired, and an entry already indexed is checked for new commits.
 *
 * Removal retires rather than deletes. A registry edit is easy to get wrong and
 * a typo should not destroy an index; re-adding the line brings it back, and
 * `memory registry-purge` is the explicit way to reclaim the space.
 */
export type RegistryAction="indexed"|"synced"|"retired"|"restored"|"failed";

export interface RegistryOutcome {
  repository:string;
  action:RegistryAction;
  detail?:unknown;
  error?:string;
}

export interface RegistryReconcileOptions {
  /** Retire repositories the registry no longer lists. */
  retireMissing?:boolean;
  /**
   * Also check already-indexed repositories for new commits.
   *
   * Off for the file watcher on purpose: the registry decides *membership*, and
   * pulling commits is the webhook's job. A registry edit re-indexing unrelated
   * projects would be a surprise, and a quiet fallback would hide a repository
   * whose CI trigger was never wired up.
   */
  syncExisting?:boolean;
}

export async function reconcileRegistry(
  memoryDb:MemoryDatabase,
  options:RegistryReconcileOptions={},
):Promise<RegistryOutcome[]> {
  const {retireMissing=true,syncExisting=true}=options;
  // Membership is always reconciled; syncExisting only adds the commit check.
  const store=new MemoryStore(memoryDb);
  const registry=await loadRegistry();
  const outcomes:RegistryOutcome[]=[];
  const registered=new Set<string>();

  for (const entry of registry.repositories) {
    registered.add(entry.name);
    try {
      const config=resolveRepositoryConfig(entry);
      const known=store.getRepository(entry.name,{includeRetired:true});
      const wasRetired=Boolean(known?.retired_at);
      const neverIndexed=!known||!known.last_indexed_sha;

      if (wasRetired) store.restoreRepository(entry.name);

      if (neverIndexed) {
        outcomes.push({repository:entry.name,action:"indexed",detail:await fullIndex(config,memoryDb)});
        continue;
      }
      if (wasRetired) {
        outcomes.push({repository:entry.name,action:"restored",detail:{lastIndexedSha:known.last_indexed_sha}});
        continue;
      }
      // Cheap when nothing moved: an unchanged repository returns NOOP.
      if (syncExisting) outcomes.push({repository:entry.name,action:"synced",detail:await incrementalSync(config,memoryDb)});
    } catch (error) {
      outcomes.push({repository:entry.name,action:"failed",error:(error as Error).message});
    }
  }

  if (retireMissing) {
    for (const known of store.listRepositories()) {
      if (registered.has(known.name)) continue;
      store.retireRepository(known.name);
      outcomes.push({repository:known.name,action:"retired",
        detail:{lastIndexedSha:known.last_indexed_sha,note:"re-add the registry entry to restore"}});
    }
  }
  return outcomes;
}

function describe(outcomes:RegistryOutcome[]):string {
  const counts=outcomes.reduce((totals:Record<string,number>,item)=>{
    if (item.action==="synced"&&(item.detail as any)?.type==="NOOP") { totals.unchanged=(totals.unchanged ?? 0)+1; return totals; }
    totals[item.action]=(totals[item.action] ?? 0)+1;
    return totals;
  },{});
  return Object.entries(counts).map(([key,value])=>`${key} ${value}`).join(", ") || "nothing to do";
}

/**
 * Watches the registry file and reconciles on change, so adding or removing a
 * line is the whole operation. A periodic pass is opt-in and catches commits
 * that arrive without a webhook.
 */
export function startRegistrySupervisor(
  memoryDb:MemoryDatabase,
  enqueue:<T>(job:()=>Promise<T>)=>Promise<T>,
):()=>void {
  const enabled=(process.env.MEMORY_REGISTRY_WATCH ?? "1")!=="0";
  const intervalMinutes=Number(process.env.MEMORY_RECONCILE_INTERVAL_MINUTES ?? 0);
  const stoppers:Array<()=>void>=[];

  const run=(reason:string,options:RegistryReconcileOptions={})=>{
    void enqueue(()=>reconcileRegistry(memoryDb,options)).then(
      (outcomes)=>{
        const failures=outcomes.filter((item)=>item.action==="failed");
        console.error(`[memory] registry reconcile (${reason}): ${describe(outcomes)}`);
        for (const failure of failures) console.error(`[memory]   ${failure.repository}: ${failure.error}`);
      },
      (error)=>console.error(`[memory] registry reconcile (${reason}) failed: ${(error as Error).message}`),
    );
  };

  if (enabled) {
    const file=registryPath();
    let timer:NodeJS.Timeout|undefined;
    let watcher:FSWatcher|undefined;
    try {
      // Editors write in several steps; debounce so one save is one reconcile.
      watcher=watch(file,()=>{
        if (timer) clearTimeout(timer);
        // Membership only: added, removed, re-added. Commits arrive by webhook.
        timer=setTimeout(()=>run("registry changed",{syncExisting:false}),750);
      });
      stoppers.push(()=>{ if (timer) clearTimeout(timer); watcher?.close(); });
      console.error(`[memory] watching ${file}; adding or removing an entry is the whole operation`);
      console.error("[memory] commits arrive by webhook; set MEMORY_RECONCILE_INTERVAL_MINUTES only where no webhook exists");
    } catch (error) {
      console.error(`[memory] registry watch unavailable: ${(error as Error).message}`);
    }
    // One pass at startup so a registry edited while the server was down still lands.
    run("startup",{syncExisting:false});
  }

  if (Number.isFinite(intervalMinutes)&&intervalMinutes>0) {
    const milliseconds=Math.max(60_000,intervalMinutes*60_000);
    const timer=setInterval(()=>run("scheduled"),milliseconds);
    timer.unref();
    stoppers.push(()=>clearInterval(timer));
    console.error(`[memory] scheduled reconciliation enabled every ${intervalMinutes} minute(s)`);
  }

  return ()=>{ for (const stop of stoppers) stop(); };
}
