import { stat } from "node:fs/promises";
import path from "node:path";
import { dbPath, loadRegistry, projectRoot } from "../config.js";
import type { MemoryDatabase } from "../memory/database.js";
import { MemoryStore } from "../memory/store.js";
import { evaluateFreshness } from "../retrieval/freshness.js";
import { runSecurityAudit } from "../security/audit.js";
import { RetrievalTelemetry } from "../telemetry/retrieval-telemetry.js";
import { readJson } from "../utils/fs.js";
import { evaluateSecondPilotGate } from "./pilot-gate.js";

/**
 * RCE-029 controlled multi-repository rollout.
 *
 * Growth is gated per wave, and the gate looks backwards as well as forwards: a
 * regression in an already-onboarded repository halts growth even when the new
 * candidate is ready. Adding repositories to a degrading engine multiplies the
 * degradation.
 */
export interface RolloutWave { name:string; size:number; entry:string; soakDays:number }

export interface RepositoryHealth {
  repository:string;
  healthy:boolean;
  freshnessState:string;
  duplicationRatio:number|null;
  evidenceCoverage:number|null;
  reasons:string[];
}

export interface RolloutReport {
  ranAt:string;
  currentCount:number;
  currentWave:RolloutWave|null;
  nextWave:RolloutWave|null;
  repositories:RepositoryHealth[];
  operatingCost:{
    databaseBytes:number|null;
    databaseBytesPerRepository:number|null;
    retrievalLatencyP95Ms:number|null;
    withinBudget:boolean|null;
    findings:string[];
  };
  gate:{decision:string;blockers:string[]};
  decision:"advance"|"hold";
  blockers:string[];
}

interface RolloutPolicy {
  waves:RolloutWave[];
  healthFloor:{freshnessState:string[];securityAuditFailures:{max:number};duplicationRatio:{max:number};evidenceCoverage:{min:number}};
  operatingCost:{databaseBytesPerRepository:{max:number};retrievalLatencyP95Ms:{max:number}};
}

async function policy():Promise<RolloutPolicy> {
  const loaded=await readJson<any>(path.join(projectRoot(),"config/rollout-gates.json"));
  const multi=loaded?.multiRepository ?? {};
  return {
    waves:(multi.waves ?? []) as RolloutWave[],
    healthFloor:{
      freshnessState:multi.healthFloor?.freshnessState ?? ["fresh"],
      securityAuditFailures:{max:Number(multi.healthFloor?.securityAuditFailures?.max ?? 0)},
      duplicationRatio:{max:Number(multi.healthFloor?.duplicationRatio?.max ?? 0.05)},
      evidenceCoverage:{min:Number(multi.healthFloor?.evidenceCoverage?.min ?? 0.95)},
    },
    operatingCost:{
      databaseBytesPerRepository:{max:Number(multi.operatingCost?.databaseBytesPerRepository?.max ?? 52_428_800)},
      retrievalLatencyP95Ms:{max:Number(multi.operatingCost?.retrievalLatencyP95Ms?.max ?? 5_000)},
    },
  };
}

export async function evaluateRollout(
  memoryDb:MemoryDatabase,
  /** `gate` may be supplied by a caller that already evaluated it, so it is computed once per run. */
  options:{evalRun?:string;economyRun?:string;gate?:{decision:string;blockers:string[]}}={},
):Promise<RolloutReport> {
  const rules=await policy();
  const store=new MemoryStore(memoryDb);
  const registry=await loadRegistry();
  const indexed=store.listRepositories() as any[];
  const currentCount=indexed.length;

  const currentWave=[...rules.waves].reverse().find((wave)=>wave.size<=currentCount) ?? null;
  const nextWave=rules.waves.find((wave)=>wave.size>currentCount) ?? null;

  // Backwards check first: every repository already onboarded must still be healthy.
  const repositories:RepositoryHealth[]=[];
  for (const row of indexed) {
    const name=row.name as string;
    const reasons:string[]=[];
    let freshnessState="unknown";
    try { freshnessState=(await evaluateFreshness(memoryDb,name)).state; }
    catch (error) { reasons.push(`freshness unavailable: ${(error as Error).message}`); }
    if (!rules.healthFloor.freshnessState.includes(freshnessState)) reasons.push(`freshness state ${freshnessState} is below the floor`);

    const quality=store.qualityReport(name) as any;
    const duplication=quality.duplicationRatio ?? null;
    const coverage=quality.evidenceCoverage ?? null;
    if (duplication!=null&&duplication>rules.healthFloor.duplicationRatio.max) {
      reasons.push(`duplication ${duplication} over ${rules.healthFloor.duplicationRatio.max}`);
    }
    if (coverage!=null&&coverage<rules.healthFloor.evidenceCoverage.min) {
      reasons.push(`evidence coverage ${coverage} under ${rules.healthFloor.evidenceCoverage.min}`);
    }
    repositories.push({repository:name,healthy:reasons.length===0,freshnessState,
      duplicationRatio:duplication,evidenceCoverage:coverage,reasons});
  }

  const audit=await runSecurityAudit(memoryDb);
  const telemetry=new RetrievalTelemetry(memoryDb).report();

  let databaseBytes:number|null=null;
  try { databaseBytes=(await stat(dbPath())).size; } catch { databaseBytes=null; }
  const perRepository=databaseBytes!=null&&currentCount>0 ? Math.round(databaseBytes/currentCount) : null;
  const latencyP95=telemetry.latencyMs?.p95 ?? null;
  const costFindings:string[]=[];
  if (perRepository!=null&&perRepository>rules.operatingCost.databaseBytesPerRepository.max) {
    costFindings.push(`database uses ${perRepository} bytes per repository, over ${rules.operatingCost.databaseBytesPerRepository.max}`);
  }
  if (latencyP95!=null&&latencyP95>rules.operatingCost.retrievalLatencyP95Ms.max) {
    costFindings.push(`retrieval p95 ${latencyP95}ms over ${rules.operatingCost.retrievalLatencyP95Ms.max}ms`);
  }

  const gate=options.gate ?? await evaluateSecondPilotGate(memoryDb,{evalRun:options.evalRun,economyRun:options.economyRun});

  const blockers:string[]=[];
  if (gate.decision!=="open") blockers.push(`acceptance gate is ${gate.decision}: ${gate.blockers.length} blocker(s)`);
  for (const item of repositories.filter((entry)=>!entry.healthy)) {
    blockers.push(`${item.repository} below the health floor: ${item.reasons.join("; ")}`);
  }
  if (audit.failed>rules.healthFloor.securityAuditFailures.max) blockers.push(`${audit.failed} security invariant(s) failing`);
  blockers.push(...costFindings);
  if (!nextWave) blockers.push("no further wave is defined; the registry is at its planned ceiling");
  const unregistered=indexed.filter((row)=>!registry.repositories.some((item)=>item.name===row.name));
  for (const row of unregistered) blockers.push(`indexed repository is not in the registry: ${row.name}`);

  return {
    ranAt:new Date().toISOString(),
    currentCount,currentWave,nextWave,repositories,
    operatingCost:{databaseBytes,databaseBytesPerRepository:perRepository,retrievalLatencyP95Ms:latencyP95,
      withinBudget:costFindings.length ? false : (perRepository==null&&latencyP95==null ? null : true),
      findings:costFindings},
    gate:{decision:gate.decision,blockers:gate.blockers},
    decision:blockers.length ? "hold" : "advance",
    blockers,
  };
}
