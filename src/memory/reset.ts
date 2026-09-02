import { rm, stat } from "node:fs/promises";
import type { MemoryDatabase } from "./database.js";

/**
 * Deleting the index is irreversible and rebuilding it costs a full re-analysis
 * of every repository, so a reset never runs implicitly: the caller states what
 * it wants gone, reads back what that means, and confirms.
 */
export type ResetScope="index"|"telemetry"|"all";

export interface ResetPlan {
  scope:ResetScope;
  hard:boolean;
  file:string;
  /** Row counts that would be destroyed, per table. */
  counts:Record<string,number>;
  totalRows:number;
  repositories:string[];
}

export interface ResetResult extends ResetPlan {
  performed:boolean;
  /** Files removed by a hard reset, including SQLite's sidecar journals. */
  removedFiles:string[];
  remaining:Record<string,number>;
}

/** Indexed knowledge: everything a re-index can reproduce. */
const INDEX_TABLES=["memory_evidence","memories","routes","route_dependencies","dependencies",
  "repository_package_dependencies","index_run_changes","index_runs","repository_snapshots","repositories"];

/** Observed usage: what the engine learned about its own answers. It cannot be re-derived. */
const TELEMETRY_TABLES=["answer_feedback","retrieval_events"];

/** Human-approved records; never removed unless the whole database goes. */
const CURATED_TABLES=["repository_decisions"];

function tablesFor(scope:ResetScope):string[] {
  if (scope==="index") return INDEX_TABLES;
  if (scope==="telemetry") return TELEMETRY_TABLES;
  return [...TELEMETRY_TABLES,...CURATED_TABLES,...INDEX_TABLES];
}

function countRows(memoryDb:MemoryDatabase,table:string):number {
  try { return Number((memoryDb.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as {n:number}).n); }
  catch { return 0; }
}

export function planReset(memoryDb:MemoryDatabase,options:{scope?:ResetScope;hard?:boolean}={}):ResetPlan {
  const scope=options.scope ?? "all";
  const counts:Record<string,number>={};
  for (const table of tablesFor(scope)) counts[table]=countRows(memoryDb,table);
  let repositories:string[]=[];
  try { repositories=(memoryDb.db.prepare("SELECT name FROM repositories ORDER BY name").all() as Array<{name:string}>).map((row)=>row.name); }
  catch { repositories=[]; }
  // The file the connection actually has open, never the configured default: a
  // caller holding a different database (a test fixture, a second index) must
  // not have the configured one deleted out from under it.
  return {scope,hard:Boolean(options.hard),file:memoryDb.db.name,counts,
    totalRows:Object.values(counts).reduce((sum,value)=>sum+value,0),repositories};
}

async function removeIfPresent(file:string):Promise<string|null> {
  try { await stat(file); } catch { return null; }
  await rm(file,{force:true});
  return file;
}

/**
 * Empty the index in place, or — with `hard` — delete the database file and its
 * journals so the next run recreates the schema from scratch. A hard reset
 * closes the connection, so the caller must not reuse it afterwards.
 */
export async function resetMemory(memoryDb:MemoryDatabase,
  options:{scope?:ResetScope;hard?:boolean;confirm:boolean}):Promise<ResetResult> {
  const plan=planReset(memoryDb,options);
  if (!options.confirm) {
    return {...plan,performed:false,removedFiles:[],remaining:plan.counts};
  }

  if (plan.hard) {
    if (!plan.file||plan.file===":memory:") throw new Error("A hard reset needs a file-backed database");
    memoryDb.close();
    const removed=(await Promise.all([plan.file,`${plan.file}-wal`,`${plan.file}-shm`].map(removeIfPresent)))
      .filter((file):file is string=>file!=null);
    return {...plan,performed:true,removedFiles:removed,remaining:{}};
  }

  const tables=tablesFor(plan.scope);
  memoryDb.db.transaction(()=>{
    // Child rows first: the schema declares foreign keys, and a truncation that
    // trips one would leave the index half-erased.
    for (const table of tables) memoryDb.db.prepare(`DELETE FROM ${table}`).run();
    if (tables.includes("memories")) {
      try { memoryDb.db.prepare("DELETE FROM memory_fts").run(); } catch { /* fts table is optional */ }
      try { memoryDb.db.prepare(`DELETE FROM ${memoryDb.vectorTableName}`).run(); } catch { /* vectors are optional */ }
    }
  })();
  memoryDb.db.exec("VACUUM");

  const remaining:Record<string,number>={};
  for (const table of tables) remaining[table]=countRows(memoryDb,table);
  return {...plan,performed:true,removedFiles:[],remaining};
}
