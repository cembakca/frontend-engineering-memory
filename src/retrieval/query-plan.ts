import type { MemoryType } from "../types.js";
import { understandQuery } from "./understand.js";
import type { IntentClassification, TaskIntent } from "./intent.js";
import { classifyTaskIntent } from "./intent.js";

export type RetrievalChannel=
  |"exact-sql"
  |"graph-flow"
  |"graph-impact"
  |"verification-graph"
  |"change-audit"
  |"fts"
  |"vector"
  |"source-fallback";

export interface QueryAnchors {
  route?:string;
  files:string[];
  symbols:string[];
  config:string[];
}

export interface QueryPlanStep {
  channel:RetrievalChannel;
  operation:string;
  purpose:string;
  limit:number;
  maxChars:number;
  required:boolean;
}

export interface QueryPlanRound {
  round:1|2;
  mode:"primary"|"conditional";
  steps:QueryPlanStep[];
}

export type SecondRoundTrigger="empty"|"missing-evidence"|"missing-relations"|"unresolved-anchor"|"truncated"|"low-intent-confidence";

export interface QueryPlan {
  raw:string;
  intent:TaskIntent;
  intentConfidence:IntentClassification["confidence"];
  anchors:QueryAnchors;
  memoryTypes:MemoryType[];
  /** User-supplied constraints filter; automatically inferred types only boost ranking. */
  memoryTypeMode:"filter"|"boost"|"none";
  rounds:QueryPlanRound[];
  secondRoundTriggers:SecondRoundTrigger[];
  stopWhen:string[];
  abstainWhen:string[];
}

export interface QueryPlanOptions {
  repo?:string;
  memoryTypes?:MemoryType[];
}

export interface RetrievalOutcome {
  resultCount:number;
  evidenceCount:number;
  relationCoverage?:number;
  unresolvedAnchors?:string[];
  truncated?:boolean;
}

export interface SecondRoundDecision {
  run:boolean;
  triggers:SecondRoundTrigger[];
}

const CONFIG_STOP=new Set(["API","CDN","CI","CSR","DFS","HTML","HTTP","ISR","JS","JSON","RCE","RSC","SHA","SQL","SSR","TS","TSX","UI","URL"]);

function unique<T>(values:T[]):T[] { return [...new Set(values)]; }

function anchorsOf(raw:string,route?:string):QueryAnchors {
  const files=unique([...raw.matchAll(/(?:[\w@.()\[\]-]+\/)+[\w@.()\[\]-]+\.(?:[cm]?[jt]sx?|json|html|css|scss|md)/gi)].map((match)=>match[0]));
  const symbols=unique([...raw.matchAll(/(?:[\w@.()\[\]/-]+\.[cm]?[jt]sx?)#[A-Za-z_$][\w$]*/g)].map((match)=>match[0]));
  const config=unique([...raw.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)].map((match)=>match[0]).filter((key)=>!CONFIG_STOP.has(key)));
  return {route,files,symbols,config};
}

function step(channel:RetrievalChannel,operation:string,purpose:string,limit:number,maxChars:number,required=true):QueryPlanStep {
  return {channel,operation,purpose,limit,maxChars,required};
}

function primarySteps(intent:TaskIntent,hasStructuredAnchor:boolean):QueryPlanStep[] {
  switch (intent) {
    case "lookup": return hasStructuredAnchor
      ? [step("exact-sql","structured-lookup","Resolve exact route/entity/config facts",20,8_000)]
      : [step("fts","focused-facts","Find exact lexical facts",8,8_000)];
    case "explain-flow": return [
      step("exact-sql","resolve-flow-seed","Resolve route, file or symbol entry points",10,4_000),
      step("graph-flow","trace-flow","Build ordered evidence-bearing execution flow",40,14_000),
    ];
    case "impact": return [
      step("exact-sql","resolve-impact-seed","Resolve changed entity identity",10,4_000),
      step("graph-impact","trace-impact","Compute reverse dependency closure",100,16_000),
    ];
    case "debug": return [
      step("exact-sql","resolve-failure-surface","Resolve status, route, config and handler facts",15,6_000),
      step("graph-flow","trace-failure-path","Trace conditions through the failing flow",40,12_000),
      step("fts","failure-evidence","Find exact error and condition evidence",8,8_000),
    ];
    case "implementation-plan": return [
      step("fts","find-exemplars","Find repository-native implementation patterns",10,10_000),
      step("graph-flow","trace-exemplar","Recover the chosen pattern's dependencies and boundaries",40,12_000),
      step("verification-graph","verification-surface","Attach runnable checks and explicit test gaps",20,6_000),
    ];
    case "change-review": return [
      step("change-audit","changed-entities","Resolve the requested revision and changed entities",100,10_000),
      step("graph-impact","changed-impact","Expand changes to affected behavior surfaces",100,14_000),
      step("verification-graph","changed-verification","Find relevant checks and coverage gaps",20,6_000),
    ];
    case "verify": return [
      step("verification-graph","verification-plan","Return tests, commands and uncovered targets",50,10_000),
      step("exact-sql","target-inventory","Resolve the routes/symbols that require verification",30,6_000),
    ];
    case "unknown": return hasStructuredAnchor
      ? [step("exact-sql","bounded-anchor-lookup","Resolve only explicit structured anchors",10,4_000,false)]
      : [step("fts","bounded-discovery","Run a small lexical discovery pass",5,4_000,false)];
  }
}

function secondSteps(intent:TaskIntent):QueryPlanStep[] {
  switch (intent) {
    case "lookup": return [
      step("fts","lexical-fallback","Recover facts absent from structured tables",8,8_000,false),
      step("vector","semantic-fallback","Recover differently worded facts",5,6_000,false),
    ];
    case "explain-flow":
    case "impact": return [
      step("fts","relation-fallback","Find missing entry points or relation evidence",8,8_000,false),
      step("source-fallback","targeted-source","Open only unresolved/pruned evidence files",8,16_000,false),
    ];
    case "debug": return [
      step("vector","similar-failure","Find semantically similar failure patterns",6,7_000,false),
      step("source-fallback","targeted-source","Inspect unresolved conditions at exact evidence files",8,16_000,false),
    ];
    case "implementation-plan": return [
      step("vector","semantic-exemplars","Find patterns named differently from the request",8,8_000,false),
      step("graph-impact","edit-surface","Compute the minimum likely edit surface",80,12_000,false),
      step("source-fallback","targeted-source","Read selected exemplars before proposing edits",10,18_000,false),
    ];
    case "change-review": return [
      step("source-fallback","targeted-diff","Inspect changed hunks lacking behavior evidence",12,20_000,false),
    ];
    case "verify": return [
      step("source-fallback","verification-source","Inspect package/CI/test config for unresolved commands",8,12_000,false),
    ];
    case "unknown": return [
      step("source-fallback","explicit-anchor-only","Use source only for a user-provided exact anchor",3,6_000,false),
    ];
  }
}

function triggersFor(intent:TaskIntent,confidence:IntentClassification["confidence"]):SecondRoundTrigger[] {
  const triggers:SecondRoundTrigger[]=["empty","missing-evidence","unresolved-anchor","truncated"];
  if (["explain-flow","impact","debug","implementation-plan","change-review"].includes(intent)) triggers.push("missing-relations");
  if (confidence==="low") triggers.push("low-intent-confidence");
  return triggers;
}

export function planQuery(raw:string,options:QueryPlanOptions={}):QueryPlan {
  const understood=understandQuery(raw,{repo:options.repo,memoryTypes:options.memoryTypes});
  const classification=classifyTaskIntent(raw);
  const anchors=anchorsOf(raw,understood.route);
  const structuredInventory=classification.intent==="lookup"&&/\b(?:routes?|route'lar|repositories|repository|versions?|s[uü]r[uü]m\w*)\b/i.test(raw);
  const hasStructuredAnchor=Boolean(anchors.route||anchors.files.length||anchors.symbols.length||anchors.config.length||structuredInventory);
  const memoryTypes=understood.memoryTypes ?? [];
  return {
    raw,intent:classification.intent,intentConfidence:classification.confidence,anchors,memoryTypes,
    memoryTypeMode:options.memoryTypes?.length ? "filter" : memoryTypes.length ? "boost" : "none",
    rounds:[
      {round:1,mode:"primary",steps:primarySteps(classification.intent,hasStructuredAnchor)},
      {round:2,mode:"conditional",steps:secondSteps(classification.intent)},
    ],
    secondRoundTriggers:triggersFor(classification.intent,classification.confidence),
    stopWhen:["required anchors resolved","every factual item has evidence","required relation coverage is complete","payload budget is respected"],
    abstainWhen:["the requested fact is outside repository evidence","a decision/why claim lacks human-approved provenance","second round leaves required anchors unresolved"],
  };
}

export function decideSecondRound(plan:QueryPlan,outcome:RetrievalOutcome):SecondRoundDecision {
  const found:SecondRoundTrigger[]=[];
  if (outcome.resultCount===0) found.push("empty");
  if (outcome.evidenceCount===0) found.push("missing-evidence");
  if ((outcome.unresolvedAnchors?.length ?? 0)>0) found.push("unresolved-anchor");
  if (outcome.truncated) found.push("truncated");
  if (outcome.relationCoverage!=null&&outcome.relationCoverage<1) found.push("missing-relations");
  if (plan.intentConfidence==="low") found.push("low-intent-confidence");
  const triggers=unique(found).filter((trigger)=>plan.secondRoundTriggers.includes(trigger));
  return {run:triggers.length>0,triggers};
}
