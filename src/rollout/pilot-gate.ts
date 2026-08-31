import path from "node:path";
import { BLOCKING_SEMANTIC_GAPS } from "../analyzers/semantic-gaps.js";
import { loadRegistry, projectRoot } from "../config.js";
import type { MemoryDatabase } from "../memory/database.js";
import { MemoryStore } from "../memory/store.js";
import { runSecurityAudit } from "../security/audit.js";
import { readJson } from "../utils/fs.js";

/**
 * RCE-028 second-pilot gate.
 *
 * The gate reads measured runs rather than opinions. It is expected to fail
 * while the first pilot has not met the RCE-001 contract — that is the whole
 * point of the item: a second repository multiplies an unproven engine.
 */
export interface GateCheck {
  id:string;
  requirement:string;
  status:"pass"|"fail"|"unknown";
  measured:string;
  threshold:string;
}

export interface PilotGateReport {
  ranAt:string;
  pilot:string|null;
  candidate:string|null;
  checks:GateCheck[];
  blockers:string[];
  decision:"open"|"blocked"|"insufficient-evidence";
}

interface Thresholds {
  meanEvidenceRecall:number;
  strictCaseCorrectness:number;
  cleanCaseRate:number;
  effectiveMedianSaving:number;
  engineLosesCaseRate:number;
  blockingOpenGaps:number;
  securityAuditFailures:number;
}

async function thresholds():Promise<Thresholds> {
  const loaded=await readJson<any>(path.join(projectRoot(),"config/rollout-gates.json"));
  const gate=loaded?.secondPilot ?? {};
  return {
    meanEvidenceRecall:Number(gate.retrieval?.meanEvidenceRecall?.min ?? 0.9),
    strictCaseCorrectness:Number(gate.retrieval?.strictCaseCorrectness?.min ?? 1),
    cleanCaseRate:Number(gate.retrieval?.cleanCaseRate?.min ?? 0.8),
    effectiveMedianSaving:Number(gate.economy?.effectiveMedianSaving?.min ?? 1),
    engineLosesCaseRate:Number(gate.economy?.engineLosesCaseRate?.max ?? 0.1),
    blockingOpenGaps:Number(gate.semantics?.blockingOpenGaps?.max ?? 0),
    securityAuditFailures:Number(gate.governance?.securityAuditFailures?.max ?? 0),
  };
}

function check(id:string,requirement:string,measured:string,threshold:string,ok:boolean|null):GateCheck {
  return {id,requirement,status:ok===null ? "unknown" : ok ? "pass" : "fail",measured,threshold};
}

export async function evaluateSecondPilotGate(
  memoryDb:MemoryDatabase,
  options:{candidate?:string;evalRun?:string;economyRun?:string}={},
):Promise<PilotGateReport> {
  const limits=await thresholds();
  const store=new MemoryStore(memoryDb);
  const indexed=store.listRepositories() as any[];
  const pilot=indexed[0]?.name ?? null;
  const checks:GateCheck[]=[];

  const evalRun=await readJson<any>(path.resolve(options.evalRun ?? path.join(projectRoot(),"eval-results/rce-002-run-1.json")));
  if (!evalRun?.cases?.length) {
    checks.push(check("retrieval","a context-eval run must exist","no run found","required",null));
  } else {
    const recall=Number(evalRun.totals?.meanEvidenceRecall ?? 0);
    checks.push(check("retrieval.recall","required evidence recall",recall.toFixed(4),`>= ${limits.meanEvidenceRecall}`,recall>=limits.meanEvidenceRecall));

    const strict=evalRun.cases.filter((item:any)=>item.strict);
    const strictClean=strict.filter((item:any)=>item.diagnosis?.primaryMissClass==null).length;
    const strictRate=strict.length ? strictClean/strict.length : 0;
    checks.push(check("retrieval.strict","strict cases answered without a miss",
      `${strictClean}/${strict.length}`,`>= ${limits.strictCaseCorrectness}`,strict.length>0&&strictRate>=limits.strictCaseCorrectness));

    const clean=evalRun.cases.filter((item:any)=>item.diagnosis?.primaryMissClass==null).length;
    const cleanRate=clean/evalRun.cases.length;
    checks.push(check("retrieval.clean","cases with no primary miss class",
      `${clean}/${evalRun.cases.length} (${cleanRate.toFixed(2)})`,`>= ${limits.cleanCaseRate}`,cleanRate>=limits.cleanCaseRate));
  }

  const economyRun=await readJson<any>(path.resolve(options.economyRun ?? path.join(projectRoot(),"eval-results/rce-004-economy-1.json")));
  if (!economyRun?.variableCost) {
    checks.push(check("economy","a context-economy run must exist","no run found","required",null));
  } else {
    const effective=Number(economyRun.variableCost.effective?.median ?? 0);
    checks.push(check("economy.effectiveSaving","median saving once failed packs still cost a source read",
      `${effective} tokens`,`>= ${limits.effectiveMedianSaving}`,effective>=limits.effectiveMedianSaving));
    const negatives=(economyRun.variableCost.nominal?.negativeCases ?? []).length;
    // Abstention cases have no source baseline, so they are not part of this ratio.
    const total=Number(economyRun.variableCost.comparableCases ?? economyRun.variableCost.cases ?? 0);
    const rate=total ? negatives/total : 1;
    checks.push(check("economy.engineLoses","cases where the engine costs more than reading source",
      `${negatives}/${total} (${rate.toFixed(2)})`,`<= ${limits.engineLosesCaseRate}`,rate<=limits.engineLosesCaseRate));
  }

  const openBlocking=BLOCKING_SEMANTIC_GAPS.length;
  checks.push(check("semantics.blockingGaps","analyzer semantics known to be wrong",
    `${openBlocking} open (${BLOCKING_SEMANTIC_GAPS.join(", ")})`,`<= ${limits.blockingOpenGaps}`,openBlocking<=limits.blockingOpenGaps));

  const audit=await runSecurityAudit(memoryDb);
  checks.push(check("governance.securityAudit","data governance invariants",
    `${audit.failed} failing, ${audit.skipped} skipped`,`<= ${limits.securityAuditFailures}`,audit.failed<=limits.securityAuditFailures));

  if (options.candidate) {
    const registry=await loadRegistry();
    const candidate=registry.repositories.find((item)=>item.name===options.candidate);
    const pilotRouter=indexed[0]?.router_type ?? null;
    if (!candidate) {
      checks.push(check("candidate.registered","the candidate must be in the registry",`${options.candidate} not found`,"registered",false));
    } else {
      // Diversity cannot be confirmed before indexing; the gate states what must differ.
      checks.push(check("candidate.diversity","a second pilot is justified only by a router or architecture the first does not exercise",
        `pilot router=${pilotRouter ?? "unknown"}; candidate not yet indexed`,
        "candidate must differ in router or architecture",null));
    }
  }

  const blockers=checks.filter((item)=>item.status==="fail").map((item)=>`${item.id}: ${item.measured} (needs ${item.threshold})`);
  const unknown=checks.some((item)=>item.status==="unknown");
  return {
    ranAt:new Date().toISOString(),
    pilot,
    candidate:options.candidate ?? null,
    checks,
    blockers,
    decision:blockers.length ? "blocked" : unknown ? "insufficient-evidence" : "open",
  };
}
