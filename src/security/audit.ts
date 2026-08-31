import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getRepositoryConfig, loadRegistry, projectRoot } from "../config.js";
import type { MemoryDatabase } from "../memory/database.js";
import { readJson } from "../utils/fs.js";

/**
 * RCE-027 data governance audit.
 *
 * Every rule in config/data-governance.json is checked here. A policy nobody
 * can run is a comment; this is the runnable half, and a failing invariant is
 * meant to block the rollout gates in RCE-028/029 rather than warn.
 */
export type InvariantStatus="pass"|"fail"|"skipped";

export interface InvariantResult {
  id:string;
  rule:string;
  status:InvariantStatus;
  detail:string;
  findings:string[];
}

export interface SecurityAuditReport {
  ranAt:string;
  repositories:string[];
  invariants:InvariantResult[];
  failed:number;
  skipped:number;
  ok:boolean;
}

/** Tables that hold engine data. FTS and vector shadow tables mirror them and are covered transitively. */
function dataTables(memoryDb:MemoryDatabase):string[] {
  return (memoryDb.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name NOT LIKE '%vectors%'",
  ).all() as Array<{name:string}>).map((row)=>row.name);
}

function tableBlob(memoryDb:MemoryDatabase,table:string):string {
  return JSON.stringify(memoryDb.db.prepare(`SELECT * FROM ${table}`).all());
}

interface EnvValue { key:string; value:string }

/** Values assigned in the repository's env files. These must never appear in the database. */
async function envValues(repoPath:string):Promise<EnvValue[]> {
  const values=new Map<string,EnvValue>();
  let entries:string[];
  try { entries=await readdir(repoPath); } catch { return []; }
  for (const entry of entries.filter((name)=>name.startsWith(".env"))) {
    let content:string;
    try { content=await readFile(path.join(repoPath,entry),"utf8"); } catch { continue; }
    for (const line of content.split(/\r?\n/)) {
      const match=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
      const raw=match?.[2]?.replace(/^["']|["']$/g,"").trim();
      // Short values collide with ordinary words; they are not usable as a leak signal.
      if (match&&raw&&raw.length>=6) values.set(`${match[1]}\0${raw}`,{key:match[1]!,value:raw});
    }
  }
  return [...values.values()];
}

function valueNeedsSubstringCheck(item:EnvValue):boolean {
  if (/(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|AUTH)/i.test(item.key)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(item.value)) return true;
  const classes=[/[a-z]/i.test(item.value),/[0-9]/.test(item.value),/[^a-z0-9]/i.test(item.value)].filter(Boolean).length;
  return item.value.length>=16&&classes>=3;
}

function tableContainsEnvValue(memoryDb:MemoryDatabase,table:string,item:EnvValue):boolean {
  const rows=memoryDb.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string,unknown>>;
  for (const row of rows) for (const [column,cell] of Object.entries(row)) {
    if (typeof cell!=="string") continue;
    // Exact scalar equality catches even low-entropy values without confusing a
    // repository path or controlled enum (`dependency_kind=development`) with
    // an env value. Low-entropy equality is meaningful only in payload-bearing
    // prose/JSON columns; high-entropy secrets are checked in every column below.
    if (cell===item.value&&/(?:content|subject|rationale|note|query_text|_json)$/i.test(column)) return true;
    // Substring matching is reserved for secrets/high-entropy values and URLs;
    // these commonly appear inside prose or JSON when a leak really occurs.
    if (valueNeedsSubstringCheck(item)&&cell.includes(item.value)) return true;
  }
  return false;
}

export async function runSecurityAudit(memoryDb:MemoryDatabase,options:{repository?:string}={}):Promise<SecurityAuditReport> {
  const registry=await loadRegistry();
  const names=options.repository ? [options.repository] : registry.repositories.map((item)=>item.name);
  const tables=dataTables(memoryDb);
  const invariants:InvariantResult[]=[];

  // I1 — configuration values must never be stored, only key names.
  const envFindings:string[]=[];
  let envChecked=0;
  for (const name of names) {
    let repoPath:string;
    try { repoPath=(await getRepositoryConfig(name)).path; } catch { continue; }
    const values=await envValues(repoPath);
    if (!values.length) continue;
    envChecked+=values.length;
    for (const table of tables) for (const item of values) {
      if (tableContainsEnvValue(memoryDb,table,item)) envFindings.push(`${table} contains ${item.key} value from ${name}`);
    }
  }
  invariants.push({
    id:"I1-no-env-values",rule:"store-key-names-never-values",
    status:envChecked===0 ? "skipped" : envFindings.length ? "fail" : "pass",
    detail:envChecked===0 ? "no readable env files; nothing to compare" : `${envChecked} env values checked against ${tables.length} tables`,
    findings:[...new Set(envFindings)],
  });

  // I2 — indexed evidence must stay inside a registered repository and outside generated output.
  const registered=new Set(registry.repositories.map((item)=>item.name));
  const outside=(memoryDb.db.prepare(`
    SELECT DISTINCT e.file_path FROM memory_evidence e
    JOIN memories m ON m.id=e.memory_id JOIN repositories repo ON repo.id=m.repository_id
    WHERE m.active=1 AND (e.file_path LIKE '/%' OR e.file_path LIKE '..%' OR e.file_path LIKE 'node_modules/%')
    LIMIT 20
  `).all() as Array<{file_path:string}>).map((row)=>row.file_path);
  const unregistered=(memoryDb.db.prepare("SELECT name FROM repositories").all() as Array<{name:string}>)
    .map((row)=>row.name).filter((name)=>!registered.has(name));
  invariants.push({
    id:"I2-indexed-paths-inside-registry",rule:"registry-is-the-boundary",
    status:outside.length||unregistered.length ? "fail" : "pass",
    detail:"active evidence paths must be repository-relative and inside a registered repository",
    findings:[...outside.map((file)=>`evidence path escapes the repository: ${file}`),
      ...unregistered.map((name)=>`indexed repository is not in the registry: ${name}`)],
  });

  // I3 — AI-produced memories must be labelled and evidence-gated.
  const unlabelled=memoryDb.db.prepare(
    "SELECT COUNT(*) c FROM memories WHERE active=1 AND producer!='deterministic' AND (quality_score IS NULL OR confidence!='inferred')",
  ).get() as {c:number};
  const unevidenced=memoryDb.db.prepare(
    "SELECT COUNT(*) c FROM memories m WHERE m.active=1 AND m.producer!='deterministic' AND NOT EXISTS(SELECT 1 FROM memory_evidence e WHERE e.memory_id=m.id)",
  ).get() as {c:number};
  invariants.push({
    id:"I3-ai-memories-labelled",rule:"evidence-gated-and-labelled",
    status:unlabelled.c||unevidenced.c ? "fail" : "pass",
    detail:"AI memories carry producer, quality score, inferred confidence and evidence",
    findings:[...(unlabelled.c ? [`${unlabelled.c} AI memory(ies) missing quality score or inferred confidence`] : []),
      ...(unevidenced.c ? [`${unevidenced.c} AI memory(ies) without evidence`] : [])],
  });

  // I4 — telemetry must carry identifiers and counts, never content.
  const contentFindings:string[]=[];
  const factContents=(memoryDb.db.prepare("SELECT content FROM memories WHERE active=1 LIMIT 200").all() as Array<{content:string}>)
    .map((row)=>row.content).filter((value)=>value.length>=40);
  const telemetryBlob=tables.includes("retrieval_events") ? tableBlob(memoryDb,"retrieval_events") : "";
  for (const content of factContents) {
    if (telemetryBlob.includes(content)) contentFindings.push("retrieval_events contains a stored fact content");
  }
  invariants.push({
    id:"I4-telemetry-carries-no-content",rule:"shape-not-prose",
    status:telemetryBlob ? (contentFindings.length ? "fail" : "pass") : "skipped",
    detail:telemetryBlob ? `${factContents.length} fact bodies checked against telemetry` : "no telemetry rows recorded yet",
    findings:[...new Set(contentFindings)],
  });

  // I5 — retention windows must hold.
  const policy=await readJson<any>(path.join(projectRoot(),"config/data-governance.json"));
  const retention=policy?.retention ?? {};
  const retentionFindings:string[]=[];
  const counts:Record<string,number>={};
  for (const [table,limitKey] of [["retrieval_events","retrieval_events"],["answer_feedback","answer_feedback"]] as const) {
    if (!tables.includes(table)) continue;
    counts[table]=(memoryDb.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as {c:number}).c;
  }
  const rowLimit=Number(retention.retrieval_events?.keep ?? 5000);
  if ((counts.retrieval_events ?? 0)>rowLimit) retentionFindings.push(`retrieval_events holds ${counts.retrieval_events} rows over the ${rowLimit} row policy`);
  const staleDeactivated=(memoryDb.db.prepare(
    "SELECT COUNT(*) c FROM memories WHERE active=0 AND updated_at < datetime('now', ?)",
  ).get(`-${Number(retention.deactivated_memories?.keep ?? 90)} days`) as {c:number}).c;
  if (staleDeactivated>0) retentionFindings.push(`${staleDeactivated} deactivated memories are older than the ${retention.deactivated_memories?.keep ?? 90} day window`);
  invariants.push({
    id:"I5-retention-within-policy",rule:"retention",
    status:retentionFindings.length ? "fail" : "pass",
    detail:`counts: ${JSON.stringify(counts)}`,
    findings:retentionFindings,
  });

  const failed=invariants.filter((item)=>item.status==="fail").length;
  const skipped=invariants.filter((item)=>item.status==="skipped").length;
  return {ranAt:new Date().toISOString(),repositories:names,invariants,failed,skipped,ok:failed===0};
}
