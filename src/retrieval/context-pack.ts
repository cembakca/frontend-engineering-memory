import type { VerificationGraph } from "../analyzers/verification-graph.js";
import type { SearchResult } from "../types.js";
import type { FlowTrace } from "./flow.js";
import type { ImpactTrace } from "./impact.js";
import { claimKindForConfidence, createAnswerContract, type AnswerContract, type ClaimKind, type MissingEvidence } from "./answer-contract.js";

const SCHEMA_VERSION="1.0";
const CHARS_PER_TOKEN=3.5;

export type ContextPackKind="flow"|"impact"|"implementation"|"debug"|"change-review";

export interface PackBudget {
  maxChars:number;
  usedChars:number;
  estimatedTokens:number;
  truncated:boolean;
  omitted:Record<string,number>;
}

interface BasePack {
  schemaVersion:typeof SCHEMA_VERSION;
  kind:ContextPackKind;
  query:string;
  repository:string;
  snapshotSha:string|null;
  /** RCE-026: every pack states the freshness of the snapshot it was built from. */
  freshness?:Record<string,unknown>;
  budget:PackBudget;
  answerContract:AnswerContract;
}

interface PackEvidence { file:string; line:number|null; symbol:string|null; confidence:string|null }

export interface FlowContextPack extends BasePack {
  kind:"flow";
  seed:string;
  steps:Array<{order:number;depth:number;relation:string;from:string;to:string;boundary?:string;evidence:PackEvidence}>;
  endpoints:string[];
  config:string[];
  prunedSteps:number;
}

export interface ImpactContextPack extends BasePack {
  kind:"impact";
  seed:string;
  affected:{routes:string[];apiRoutes:string[];components:string[];files:string[];config:string[];endpoints:string[];tests:string[]};
  relations:Array<{depth:number;affected:string;kind:string;relation:string;dependency:string;evidence:PackEvidence}>;
}

interface CompactFact {
  claimKind:"fact"|"inference";
  entity:string;
  type:string;
  fact:string;
  evidence:PackEvidence[];
  score:number|null;
}

interface CompactVerification {
  commands:Array<{claimKind:"fact";name:string;kind:string;command:string;evidence:PackEvidence}>;
  tests:Array<{claimKind:"fact";key:string;framework:string;evidence:PackEvidence}>;
  gaps:Array<{kind:string;target?:string;reason:string}>;
}

export interface ImplementationContextPack extends BasePack {
  kind:"implementation";
  exemplars:CompactFact[];
  editSurface:{files:string[];routes:string[];components:string[];config:string[]};
  verification:CompactVerification;
}

export interface DebugContextPack extends BasePack {
  kind:"debug";
  facts:CompactFact[];
  failurePath:Array<{order:number;relation:string;from:string;to:string;evidence:PackEvidence}>;
  checks:string[];
  endpoints:string[];
  config:string[];
}

export interface ChangeReviewContextPack extends BasePack {
  kind:"change-review";
  changes:Array<{claimKind:"fact";operation:string;entity:string;file:string|null;fromSha:string|null;toSha:string|null}>;
  affected:{routes:string[];apiRoutes:string[];components:string[];files:string[];tests:string[]};
  verification:CompactVerification;
}

export type ContextPack=FlowContextPack|ImpactContextPack|ImplementationContextPack|DebugContextPack|ChangeReviewContextPack;

interface CommonInput { query:string;repository:string;snapshotSha?:string|null;gaps?:string[];sourceFallback?:string[];freshness?:Record<string,unknown> }
export type ContextPackInput=
  |(CommonInput&{kind:"flow";trace:FlowTrace})
  |(CommonInput&{kind:"impact";trace:ImpactTrace})
  |(CommonInput&{kind:"implementation";exemplars:SearchResult[];impact?:ImpactTrace;verification?:VerificationGraph;verificationFirst?:boolean})
  |(CommonInput&{kind:"debug";facts:SearchResult[];trace?:FlowTrace;checks?:string[]})
  |(CommonInput&{kind:"change-review";changes:Array<{operation:string;entity:string;file?:string|null;fromSha?:string|null;toSha?:string|null}>;impact?:ImpactTrace;verification?:VerificationGraph});

function budget(maxChars:number):PackBudget {
  return {maxChars,usedChars:0,estimatedTokens:0,truncated:false,omitted:{}};
}

function base(input:CommonInput&{kind:ContextPackKind},maxChars:number):BasePack {
  return {schemaVersion:SCHEMA_VERSION,kind:input.kind,query:input.query,repository:input.repository,
    snapshotSha:input.snapshotSha ?? null,
    ...(input.freshness ? {freshness:input.freshness} : {}),
    budget:budget(maxChars),answerContract:createAnswerContract({})};
}

function evidence(file:string|null|undefined,line:number|null|undefined,symbol:string|null|undefined,confidence:string|null|undefined):PackEvidence {
  return {file:file ?? "",line:line ?? null,symbol:symbol ?? null,confidence:confidence ?? null};
}

function fact(result:SearchResult):CompactFact {
  return {claimKind:claimKindForConfidence(result.confidence),entity:result.canonicalEntity ?? `${result.repository}:${result.type}:${result.subject}`,type:result.type,fact:result.content,
    evidence:(result.sourceFiles?.length ? result.sourceFiles : result.sourceFile ? [result.sourceFile] : []).map((file)=>evidence(file,null,null,result.confidence)),
    score:result.ranking?.score ?? (Number.isFinite(result.score) ? result.score : null)};
}

function verification(value:VerificationGraph|undefined):CompactVerification {
  if (!value) return {commands:[],tests:[],gaps:[]};
  return {
    commands:value.commands.map((item)=>({claimKind:"fact",name:item.name,kind:item.kind,command:item.command,evidence:evidence(item.file,item.line,null,"observed")})),
    tests:value.tests.map((item)=>({claimKind:"fact",key:item.key,framework:item.framework,evidence:evidence(item.file,item.line,item.title,"observed")})),
    gaps:value.gaps.map((item)=>({kind:item.kind,...(item.target ? {target:item.target} : {}),reason:item.reason})),
  };
}

/** Append only when the whole JSON pack remains under a conservative reserve. */
function append<T>(pack:ContextPack,target:T[],item:T,section:string,effectiveMax:number):void {
  target.push(item);
  if (JSON.stringify(pack).length<=effectiveMax) return;
  target.pop();
  pack.budget.truncated=true;
  pack.budget.omitted[section]=(pack.budget.omitted[section] ?? 0)+1;
}

function selectors(pack:ContextPack):{facts:string[];derivedRelations:string[];inferences:string[];uncertainty:string[];missingEvidence:MissingEvidence[]} {
  const facts:string[]=[];
  const derivedRelations:string[]=[];
  const inferences:string[]=[];
  const uncertainty:string[]=[];
  const missingEvidence:MissingEvidence[]=[];
  const inspectEvidence=(items:Array<{evidence?:PackEvidence|PackEvidence[]}>,path:string):void=>{
    items.forEach((item,index)=>{
      const evidenceList=Array.isArray(item.evidence) ? item.evidence : item.evidence ? [item.evidence] : [];
      if (!evidenceList.length||evidenceList.every((entry)=>!entry.file)) missingEvidence.push({path:`${path}[${index}]`,reason:"claim has no located source evidence"});
    });
  };
  const classify=(items:Array<{claimKind:ClaimKind;evidence?:PackEvidence|PackEvidence[]}>,path:string):void=>{
    if (items.some((item)=>item.claimKind==="fact")) facts.push(`${path}[claimKind=fact]`);
    if (items.some((item)=>item.claimKind==="derived-relation")) derivedRelations.push(path);
    if (items.some((item)=>item.claimKind==="inference")) inferences.push(`${path}[claimKind=inference]`);
    inspectEvidence(items,path);
  };
  if (pack.kind==="flow") {
    if (pack.steps.length) derivedRelations.push("steps");
    inspectEvidence(pack.steps,"steps");
    if (pack.endpoints.length) derivedRelations.push("endpoints");
    if (pack.config.length) derivedRelations.push("config");
  } else if (pack.kind==="impact") {
    if (pack.relations.length) derivedRelations.push("relations");
    inspectEvidence(pack.relations,"relations");
    if (Object.values(pack.affected).some((items)=>items.length)) derivedRelations.push("affected");
  } else if (pack.kind==="implementation") {
    classify(pack.exemplars,"exemplars");
    classify(pack.verification.commands,"verification.commands");
    classify(pack.verification.tests,"verification.tests");
    for (const gap of pack.verification.gaps) {
      uncertainty.push(gap.reason);
      missingEvidence.push({path:gap.target ? `verification:${gap.target}` : "verification",reason:gap.reason});
    }
    if (Object.values(pack.editSurface).some((items)=>items.length)) derivedRelations.push("editSurface");
  } else if (pack.kind==="debug") {
    classify(pack.facts,"facts");
    if (pack.failurePath.length) derivedRelations.push("failurePath");
    inspectEvidence(pack.failurePath,"failurePath");
    if (pack.endpoints.length) derivedRelations.push("endpoints");
    if (pack.config.length) derivedRelations.push("config");
  } else {
    classify(pack.changes.map((item)=>({...item,evidence:item.file ? evidence(item.file,null,null,"observed") : []})),"changes");
    classify(pack.verification.commands,"verification.commands");
    classify(pack.verification.tests,"verification.tests");
    for (const gap of pack.verification.gaps) {
      uncertainty.push(gap.reason);
      missingEvidence.push({path:gap.target ? `verification:${gap.target}` : "verification",reason:gap.reason});
    }
    if (Object.values(pack.affected).some((items)=>items.length)) derivedRelations.push("affected");
  }
  return {facts,derivedRelations,inferences,uncertainty,missingEvidence};
}

function finalize<T extends ContextPack>(pack:T,input:CommonInput,extraUncertainty:string[]=[]):T {
  const claims=selectors(pack);
  const uncertainty=[...(input.gaps ?? []),...extraUncertainty,...claims.uncertainty];
  const missingEvidence=[...claims.missingEvidence];
  const sourceFallback=[...(input.sourceFallback ?? [])];
  const empty=!claims.facts.length&&!claims.derivedRelations.length&&!claims.inferences.length;
  const rebuild=()=>{
    pack.answerContract=createAnswerContract({...claims,uncertainty,missingEvidence,sourceFallback,
      truncated:pack.budget.truncated,empty});
  };
  rebuild();
  while (JSON.stringify(pack).length>pack.budget.maxChars&&(sourceFallback.length||missingEvidence.length||uncertainty.length)) {
    if (sourceFallback.length) sourceFallback.pop();
    else if (missingEvidence.length) missingEvidence.pop();
    else uncertainty.pop();
    pack.budget.truncated=true;
    pack.budget.omitted.answerContract=(pack.budget.omitted.answerContract ?? 0)+1;
    rebuild();
  }
  for (let attempt=0;attempt<3;attempt+=1) {
    pack.budget.usedChars=JSON.stringify(pack).length;
    pack.budget.estimatedTokens=Math.ceil(pack.budget.usedChars/CHARS_PER_TOKEN);
  }
  // Budget counter digit growth happens after the first contract fit. Remove
  // one more optional contract entry when that final metadata crosses the cap.
  for (let guard=0;JSON.stringify(pack).length>pack.budget.maxChars&&guard<100;guard+=1) {
    if (sourceFallback.length) sourceFallback.pop();
    else if (missingEvidence.length) missingEvidence.pop();
    else if (uncertainty.length) uncertainty.pop();
    else break;
    pack.budget.truncated=true;
    pack.budget.omitted.answerContract=(pack.budget.omitted.answerContract ?? 0)+1;
    rebuild();
    for (let attempt=0;attempt<3;attempt+=1) {
      pack.budget.usedChars=JSON.stringify(pack).length;
      pack.budget.estimatedTokens=Math.ceil(pack.budget.usedChars/CHARS_PER_TOKEN);
    }
  }
  return pack;
}

function copyStrings(pack:ContextPack,target:string[],values:string[],section:string,effectiveMax:number):void {
  for (const value of values) append(pack,target,value,section,effectiveMax);
}

export function compileContextPack(input:ContextPackInput,options:{maxChars?:number}={}):ContextPack {
  const maxChars=Math.max(1_000,Math.min(24_000,options.maxChars ?? 8_000));
  // Reserve covers final budget counters and small digit growth.
  // The empty non-optional contract is already present in the pack; reserve
  // only selector growth and final budget counters.
  const effectiveMax=maxChars-240;

  if (input.kind==="flow") {
    const pack:FlowContextPack={...base(input,maxChars),kind:"flow",seed:input.trace.seed,steps:[],endpoints:[],config:[],prunedSteps:input.trace.prunedSteps};
    copyStrings(pack,pack.endpoints,input.trace.endpoints,"endpoints",effectiveMax);
    copyStrings(pack,pack.config,input.trace.config,"config",effectiveMax);
    for (const item of input.trace.steps) append(pack,pack.steps,{order:item.order,depth:item.depth,relation:item.edge,from:item.from,to:item.to,
      ...(item.boundary ? {boundary:item.boundary} : {}),evidence:evidence(item.file,item.line,item.symbol,item.confidence)},"steps",effectiveMax);
    return finalize(pack,input,input.trace.truncated ? ["flow traversal was truncated"] : []);
  }

  if (input.kind==="impact") {
    const pack:ImpactContextPack={...base(input,maxChars),kind:"impact",seed:input.trace.seed,
      affected:{routes:[],apiRoutes:[],components:[],files:[],config:[],endpoints:[],tests:[]},relations:[]};
    for (const key of ["routes","apiRoutes","components","files","config","endpoints","tests"] as const) {
      copyStrings(pack,pack.affected[key],input.trace[key],`affected.${key}`,effectiveMax);
    }
    for (const item of input.trace.steps) append(pack,pack.relations,{depth:item.depth,affected:item.affected,kind:item.affectedKind,
      relation:item.via,dependency:item.dependency,evidence:evidence(item.file,item.line,item.symbol,item.confidence)},"relations",effectiveMax);
    return finalize(pack,input,input.trace.truncated ? ["impact traversal was truncated"] : []);
  }

  if (input.kind==="implementation") {
    const pack:ImplementationContextPack={...base(input,maxChars),kind:"implementation",exemplars:[],
      editSurface:{files:[],routes:[],components:[],config:[]},verification:{commands:[],tests:[],gaps:[]}};
    const checks=verification(input.verification);
    const appendChecks=()=>{
      // Missing validation is more important than a long list of equivalent
      // script variants. Repository-wide target gaps are useful but must not
      // crowd package scripts and global test-infrastructure gaps out.
      for (const item of checks.gaps.filter((gap)=>!gap.target)) append(pack,pack.verification.gaps,item,"verification.gaps",effectiveMax);
      for (const item of checks.commands) append(pack,pack.verification.commands,item,"verification.commands",effectiveMax);
      for (const item of checks.tests) append(pack,pack.verification.tests,item,"verification.tests",effectiveMax);
      for (const item of checks.gaps.filter((gap)=>gap.target)) append(pack,pack.verification.gaps,item,"verification.gaps",effectiveMax);
    };
    if (input.verificationFirst) appendChecks();
    // An exact graph anchor is stronger implementation evidence than fuzzy
    // exemplars. Reserve the concrete edit surface first so a long memory fact
    // cannot evict the very service/file named by the user.
    if (input.impact) {
      copyStrings(pack,pack.editSurface.files,input.impact.files,"editSurface.files",effectiveMax);
      copyStrings(pack,pack.editSurface.routes,input.impact.routes,"editSurface.routes",effectiveMax);
      copyStrings(pack,pack.editSurface.components,input.impact.components,"editSurface.components",effectiveMax);
      copyStrings(pack,pack.editSurface.config,input.impact.config,"editSurface.config",effectiveMax);
    }
    for (const item of input.exemplars) append(pack,pack.exemplars,fact(item),"exemplars",effectiveMax);
    if (!input.verificationFirst) appendChecks();
    return finalize(pack,input);
  }

  if (input.kind==="debug") {
    const pack:DebugContextPack={...base(input,maxChars),kind:"debug",facts:[],failurePath:[],checks:[],endpoints:[],config:[]};
    for (const item of input.facts) append(pack,pack.facts,fact(item),"facts",effectiveMax);
    if (input.trace) {
      copyStrings(pack,pack.endpoints,input.trace.endpoints,"endpoints",effectiveMax);
      copyStrings(pack,pack.config,input.trace.config,"config",effectiveMax);
      for (const item of input.trace.steps) append(pack,pack.failurePath,{order:item.order,relation:item.edge,from:item.from,to:item.to,
        evidence:evidence(item.file,item.line,item.symbol,item.confidence)},"failurePath",effectiveMax);
    }
    copyStrings(pack,pack.checks,input.checks ?? [],"checks",effectiveMax);
    return finalize(pack,input,input.trace?.truncated ? ["failure path was truncated"] : []);
  }

  const pack:ChangeReviewContextPack={...base(input,maxChars),kind:"change-review",changes:[],
    affected:{routes:[],apiRoutes:[],components:[],files:[],tests:[]},verification:{commands:[],tests:[],gaps:[]}};
  for (const item of input.changes) append(pack,pack.changes,{claimKind:"fact",operation:item.operation,entity:item.entity,file:item.file ?? null,
    fromSha:item.fromSha ?? null,toSha:item.toSha ?? null},"changes",effectiveMax);
  if (input.impact) {
    for (const key of ["routes","apiRoutes","components","files","tests"] as const) {
      copyStrings(pack,pack.affected[key],input.impact[key],`affected.${key}`,effectiveMax);
    }
  }
  const checks=verification(input.verification);
  for (const item of checks.commands) append(pack,pack.verification.commands,item,"verification.commands",effectiveMax);
  for (const item of checks.tests) append(pack,pack.verification.tests,item,"verification.tests",effectiveMax);
  for (const item of checks.gaps) append(pack,pack.verification.gaps,item,"verification.gaps",effectiveMax);
  return finalize(pack,input);
}
