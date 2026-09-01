import path from "node:path";
import type { MemoryDatabase } from "../memory/database.js";
import { MemoryStore } from "../memory/store.js";
import { loadRegistry, projectRoot } from "../config.js";
import { readJson } from "../utils/fs.js";
import { runContextEvaluation } from "./context-eval.js";

export type EvaluationRole="representative"|"overlay";

export interface EvaluationFleetManifest {
  version:number;
  policy:{
    representativeCases:{min:number;max:number};
    overlayCases:{min:number;max:number};
    requiredRepresentativeJobs:string[];
    requiredOverlayJobs:string[];
    thresholds:{meanEvidenceRecall:number;medianContextSavingPercent:number;primaryMisses:number;strictMisses:number};
  };
  families:Array<{id:string;description:string;representativeRepository:string}>;
  repositories:Array<{repository:string;family:string;role:EvaluationRole;suite:string}>;
}

interface EvaluationSuite {
  suite:string;
  repository:string;
  targetSha:string;
  draft?:boolean;
  cases:any[];
}

export interface FleetValidation {
  ok:boolean;
  errors:string[];
  warnings:string[];
  suites:Array<{repository:string;family:string;role:EvaluationRole;file:string;cases:number;jobs:string[]}>;
}

function rangeValid(value:{min:number;max:number}|undefined):boolean {
  return Boolean(value&&Number.isInteger(value.min)&&Number.isInteger(value.max)&&value.min>0&&value.max>=value.min);
}

function suiteFile(manifestFile:string,value:string):string {
  return path.resolve(path.dirname(path.resolve(manifestFile)),value);
}

function validateCase(item:any,index:number,repository:string):string[] {
  const label=`${repository} case ${item?.id ?? index+1}`;
  const errors:string[]=[];
  if (!item||typeof item!=="object") return [`${label}: case must be an object`];
  if (typeof item.id!=="string"||!item.id.trim()) errors.push(`${label}: id is required`);
  if (typeof item.job!=="string"||!item.job.trim()) errors.push(`${label}: job is required`);
  if (typeof item.question!=="string"||item.question.trim().length<10) errors.push(`${label}: a real developer question is required`);
  if (typeof item.strictFact!=="string"||!item.strictFact.trim()||/TODO/i.test(item.strictFact)) errors.push(`${label}: strictFact must be curated`);
  if (!Array.isArray(item.forbiddenClaims)) errors.push(`${label}: forbiddenClaims must be an array`);
  if (!Array.isArray(item.expectedEvidence)) errors.push(`${label}: expectedEvidence must be an array`);
  if (!Array.isArray(item.baselineReadSet)) errors.push(`${label}: baselineReadSet must be an array`);
  if (!Array.isArray(item.plan)||!item.plan.length) errors.push(`${label}: at least one MCP plan step is required`);
  if (item.policy!=="abstain"&&item.job!=="negative"&&Array.isArray(item.expectedEvidence)&&!item.expectedEvidence.length) {
    errors.push(`${label}: non-negative cases require expected source evidence`);
  }
  return errors;
}

/** Validate that every registered repository is covered by one enforced architecture-family suite. */
export async function validateEvaluationFleet(
  manifestFile:string,
  options:{registryRepositories?:string[]}={},
):Promise<{manifest:EvaluationFleetManifest|null;validation:FleetValidation}> {
  const manifest=await readJson<EvaluationFleetManifest>(path.resolve(manifestFile));
  const errors:string[]=[];
  const warnings:string[]=[];
  const suites:FleetValidation["suites"]=[];
  if (!manifest) return {manifest:null,validation:{ok:false,errors:[`Invalid evaluation fleet manifest: ${path.resolve(manifestFile)}`],warnings,suites}};
  if (manifest.version!==1) errors.push(`Unsupported evaluation fleet version: ${manifest.version}`);
  if (!rangeValid(manifest.policy?.representativeCases)) errors.push("representativeCases must define a valid min/max range");
  if (!rangeValid(manifest.policy?.overlayCases)) errors.push("overlayCases must define a valid min/max range");

  const familyIds=new Set<string>();
  for (const family of manifest.families ?? []) {
    if (!family.id||familyIds.has(family.id)) errors.push(`Duplicate or empty family id: ${family.id}`);
    familyIds.add(family.id);
  }
  const assignments=new Set<string>();
  const globalCaseIds=new Set<string>();
  for (const entry of manifest.repositories ?? []) {
    if (assignments.has(entry.repository)) errors.push(`Repository assigned more than once: ${entry.repository}`);
    assignments.add(entry.repository);
    if (!familyIds.has(entry.family)) errors.push(`${entry.repository}: unknown family ${entry.family}`);
    if (entry.role!=="representative"&&entry.role!=="overlay") errors.push(`${entry.repository}: invalid role ${entry.role}`);
    const file=suiteFile(manifestFile,entry.suite);
    const suite=await readJson<EvaluationSuite>(file);
    if (!suite) { errors.push(`${entry.repository}: invalid suite ${file}`); continue; }
    if (suite.repository!==entry.repository) errors.push(`${entry.repository}: suite repository is ${suite.repository}`);
    if (suite.draft) errors.push(`${entry.repository}: draft suite cannot enter the fleet gate`);
    const range=entry.role==="representative" ? manifest.policy.representativeCases : manifest.policy.overlayCases;
    if (suite.cases.length<range.min||suite.cases.length>range.max) {
      errors.push(`${entry.repository}: ${entry.role} suite has ${suite.cases.length} cases; expected ${range.min}-${range.max}`);
    }
    const jobs=[...new Set(suite.cases.map((item)=>String(item.job)))].sort();
    const required=entry.role==="representative" ? manifest.policy.requiredRepresentativeJobs : manifest.policy.requiredOverlayJobs;
    for (const job of required) if (!jobs.includes(job)) errors.push(`${entry.repository}: ${entry.role} suite is missing ${job}`);
    suite.cases.forEach((item,index)=>{
      errors.push(...validateCase(item,index,entry.repository));
      if (item?.id&&globalCaseIds.has(item.id)) errors.push(`Duplicate fleet case id: ${item.id}`);
      if (item?.id) globalCaseIds.add(item.id);
    });
    suites.push({repository:entry.repository,family:entry.family,role:entry.role,file,cases:suite.cases.length,jobs});
  }

  for (const family of manifest.families ?? []) {
    const representatives=(manifest.repositories ?? []).filter((item)=>item.family===family.id&&item.role==="representative");
    if (representatives.length!==1) errors.push(`${family.id}: exactly one representative suite is required`);
    else if (representatives[0]!.repository!==family.representativeRepository) {
      errors.push(`${family.id}: representativeRepository does not match its representative assignment`);
    }
  }
  const registry=options.registryRepositories ?? (await loadRegistry()).repositories.map((item)=>item.name);
  for (const repository of registry) if (!assignments.has(repository)) errors.push(`${repository}: registered repository has no evaluation assignment`);
  for (const repository of assignments) if (!registry.includes(repository)) warnings.push(`${repository}: evaluation assignment is not in the local registry`);
  return {manifest,validation:{ok:errors.length===0,errors,warnings,suites}};
}

function median(values:number[]):number|null {
  if (!values.length) return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.floor(sorted.length/2)]!;
}

export async function runEvaluationFleet(memoryDb:MemoryDatabase,manifestFile=path.join(projectRoot(),"config/evaluation-fleet.json"),options:{validateOnly?:boolean}={}):Promise<any> {
  const checked=await validateEvaluationFleet(manifestFile);
  if (!checked.manifest||!checked.validation.ok||options.validateOnly) {
    return {manifest:path.resolve(manifestFile),decision:checked.validation.ok ? "valid" : "hold",validation:checked.validation,runs:[]};
  }
  const runs=[];
  for (const entry of checked.manifest.repositories) {
    const result=await runContextEvaluation(memoryDb,suiteFile(manifestFile,entry.suite));
    runs.push({family:entry.family,role:entry.role,...result});
  }
  const cases=runs.flatMap((run)=>run.cases as any[]);
  const recalls=cases.map((item)=>item.evidence.recall).filter((value):value is number=>value!=null);
  const savings=cases.map((item)=>item.contextSavingPercent).filter((value):value is number=>value!=null);
  const primaryMisses=cases.filter((item)=>item.diagnosis.primaryMissClass||item.engine.error).length;
  const strictMisses=cases.filter((item)=>item.strict&&(item.diagnosis.primaryMissClass||item.engine.error||(item.evidence.recall!=null&&item.evidence.recall<1))).length;
  const totals={
    repositories:runs.length,
    families:new Set(runs.map((run)=>run.family)).size,
    cases:cases.length,
    meanEvidenceRecall:recalls.length ? Number((recalls.reduce((sum,value)=>sum+value,0)/recalls.length).toFixed(4)) : null,
    medianContextSavingPercent:median(savings),
    primaryMisses,
    strictMisses,
    shaMatches:runs.every((run)=>run.shaMatchesTarget),
    cleanTrees:runs.every((run)=>!run.workingTreeDirty),
  };
  const threshold=checked.manifest.policy.thresholds;
  const checks=[
    {name:"mean-evidence-recall",ok:totals.meanEvidenceRecall!=null&&totals.meanEvidenceRecall>=threshold.meanEvidenceRecall,actual:totals.meanEvidenceRecall,required:threshold.meanEvidenceRecall},
    {name:"median-context-saving",ok:totals.medianContextSavingPercent!=null&&totals.medianContextSavingPercent>=threshold.medianContextSavingPercent,actual:totals.medianContextSavingPercent,required:threshold.medianContextSavingPercent},
    {name:"primary-misses",ok:primaryMisses<=threshold.primaryMisses,actual:primaryMisses,required:threshold.primaryMisses},
    {name:"strict-misses",ok:strictMisses<=threshold.strictMisses,actual:strictMisses,required:threshold.strictMisses},
    {name:"target-sha",ok:totals.shaMatches,actual:totals.shaMatches,required:true},
    {name:"clean-working-trees",ok:totals.cleanTrees,actual:totals.cleanTrees,required:true},
  ];
  return {manifest:path.resolve(manifestFile),decision:checks.every((item)=>item.ok) ? "pass" : "hold",validation:checked.validation,totals,checks,
    runs:runs.map((run)=>({family:run.family,role:run.role,suite:run.suite,repository:run.repository,targetSha:run.targetSha,
      totals:run.totals,shaMatchesTarget:run.shaMatchesTarget,workingTreeDirty:run.workingTreeDirty}))};
}

function parsed(value:string|undefined,fallback:any):any { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }

/** Produce a six/seven-case overlay draft from indexed structure; humans must review it before fleet admission. */
export function scaffoldEvaluationOverlay(memoryDb:MemoryDatabase,repository:string,family:string):any {
  const store=new MemoryStore(memoryDb);
  const repo=store.getRepository(repository) as any;
  if (!repo) throw new Error(`Repository not found: ${repository}`);
  const routes=store.listRoutes(repository) as any[];
  const pages=routes.filter((route)=>route.route_type==="page"&&!route.dynamic_route&&route.route!=="/");
  const primary=pages.find((route)=>parsed(route.backend_dependencies_json,[]).length||parsed(route.data_sources_json,[]).length) ?? pages[0] ?? routes[0];
  if (!primary) throw new Error(`Repository has no indexed routes: ${repository}`);
  const api=routes.find((route)=>route.route_type==="route-handler"||route.route_type==="api");
  const prefix=repository.split(".").filter(Boolean).map((part)=>part[0]).join("").slice(0,8).toUpperCase()||"REPO";
  const evidence=[primary.source_file,...parsed(primary.behavior_files_json,[])].filter((value,index,all)=>value&&all.indexOf(value)===index).slice(0,4);
  const cases:any[]=[
    {id:`${prefix}-E01`,job:"lookup",strict:true,question:`${primary.route} route'u hangi source dosyasından gelir ve rendering sinyali nedir?`,
      strictFact:`${primary.route} -> ${primary.source_file}; rendering=${primary.rendering_mode}`,forbiddenClaims:[],policy:"memory-sufficient",
      expectedEvidence:[primary.source_file],baselineReadSet:[primary.source_file],plan:[{tool:"memory_route",args:{route:primary.route}}]},
    {id:`${prefix}-F01`,job:"flow",strict:false,question:`${primary.route} sayfasının ana veri veya kullanıcı akışı nedir?`,
      strictFact:"TODO: confirm the ordered source-to-backend flow",forbiddenClaims:[],policy:"targeted-source",
      expectedEvidence:evidence,baselineReadSet:evidence,plan:[{tool:"memory_context",args:{}}]},
    {id:`${prefix}-I01`,job:"impact",strict:false,question:`${primary.source_file} değişirse hangi route, component ve servisler etkilenir?`,
      strictFact:"TODO: confirm the minimum reverse dependency surface",forbiddenClaims:["all routes are affected"],policy:"targeted-source",
      expectedEvidence:[primary.source_file],baselineReadSet:[primary.source_file],plan:[{tool:"memory_context",args:{}}]},
    {id:`${prefix}-P01`,job:"implementation",strict:false,question:`${primary.route} benzeri yeni bir sayfa eklerken hangi repository pattern'i izlenmeli?`,
      strictFact:"TODO: confirm the closest repository-native exemplar",forbiddenClaims:[],policy:"targeted-source",
      expectedEvidence:evidence,baselineReadSet:evidence,plan:[{tool:"memory_context",args:{}}]},
    {id:`${prefix}-V01`,job:"verify",strict:true,question:"Bu repository'de değişiklikten sonra hangi test, lint, typecheck ve build doğrulamaları çalıştırılabilir?",
      strictFact:"TODO: verify package scripts and explicit test gaps",forbiddenClaims:[],policy:"report-gap",
      expectedEvidence:["package.json"],baselineReadSet:["package.json"],plan:[{tool:"memory_context",args:{}}]},
    {id:`${prefix}-N01`,job:"negative",strict:true,question:"Ekip bu Next.js mimarisini neden seçti?",
      strictFact:"No rationale is valid without a human-approved decision record",forbiddenClaims:["performance reasons","team preference"],policy:"abstain",
      expectedEvidence:[],baselineReadSet:[],plan:[{tool:"memory_context",args:{}}]},
  ];
  if (api) cases.splice(4,0,{id:`${prefix}-D01`,job:"debug",strict:true,question:`${api.route} handler'ı hangi doğrulanmış koşullarda hata döndürebilir?`,
    strictFact:"TODO: confirm one exact guard/catch failure condition",forbiddenClaims:[],policy:"targeted-source",
    expectedEvidence:[api.source_file],baselineReadSet:[api.source_file],plan:[{tool:"memory_context",args:{}}]});
  return {suite:`${repository} ${family} overlay`,repository,targetSha:repo.last_indexed_sha,draft:true,family,role:"overlay",
    reviewRequired:["Replace every TODO strictFact with a source-verified claim","Confirm expectedEvidence and forbiddenClaims","Set draft=false only after a clean context-eval run"],cases};
}
