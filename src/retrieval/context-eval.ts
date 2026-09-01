import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getRepositoryConfig } from "../config.js";
import type { MemoryDatabase } from "../memory/database.js";
import { MemoryTools } from "../mcp/tools.js";
import { readJson } from "../utils/fs.js";
import { getHeadSha, getWorkingTreeStatus } from "../git/git.js";
import { understandQuery } from "./understand.js";

const run=promisify(execFile);

/** Same divisor the MCP context packer uses, so engine and baseline numbers stay comparable. */
const CHARS_PER_TOKEN=3.5;

/**
 * A memory counts as a focused fact about a file only when it cites a small
 * evidence set. Route memories cite their whole transitive import closure
 * (20+ files on the pilot), so citing a file proves nothing about the claim.
 */
const FOCUSED_EVIDENCE_MAX=4;

type ToolName="memory_repository"|"memory_route"|"memory_context";

interface PlanStep { tool:ToolName; args?:{route?:string;type?:string;limit?:number;maxChars?:number}; }

interface ContextEvalCase {
  id:string;
  job:"lookup"|"flow"|"impact"|"implementation"|"debug"|"verify"|"cross-repository"|"negative";
  strict:boolean;
  question:string;
  strictFact:string;
  forbiddenClaims:string[];
  policy:"memory-sufficient"|"targeted-source"|"report-gap"|"abstain";
  expectedEvidence:string[];
  baselineReadSet:string[];
  /** Literal strings that must not appear in the pack; a hit means the engine asserts something the source contradicts. */
  packForbidden?:string[];
  plan:PlanStep[];
  gitCheck?:boolean;
}

interface ContextEvalSuite {
  suite:string;
  repository:string;
  targetSha:string;
  baselineDiscovery?:{note?:string;command?:string};
  cases:ContextEvalCase[];
}

function tokensFor(chars:number):number { return Math.ceil(chars/CHARS_PER_TOKEN); }

function normalizePath(value:string):string { return value.split(path.sep).join("/"); }

/** Every file path the returned payload actually cites, wherever it appears in the tool output. */
function citedFiles(payload:string):string[] {
  const matches=payload.match(/(?:src\/|app\/)[A-Za-z0-9_\-.\[\]/]+\.(?:tsx?|jsx?|css|html|json)|next\.config\.ts|package\.json/g) ?? [];
  return [...new Set(matches.map(normalizePath))];
}

async function fileChars(repoPath:string,relative:string):Promise<number> {
  try {
    const info=await stat(path.join(repoPath,relative));
    return info.isFile() ? info.size : 0;
  } catch { return 0; }
}

async function discoveryChars(repoPath:string):Promise<number> {
  try {
    const {stdout}=await run("git",["ls-files","src"],{cwd:repoPath,maxBuffer:8_000_000});
    return stdout.length;
  } catch { return 0; }
}

/** Compact description of what a tool actually returned, so retrieval misses can be classified later. */
function summarizeResult(tool:ToolName,result:any):string[] {
  if (tool==="memory_repository") return [`repository:${result.name} next=${result.nextVersion} indexedSha=${String(result.lastIndexedSha).slice(0,7)}`];
  if (tool==="memory_route") {
    if (result.routes) return result.routes.map((row:any)=>`route:${row.route} -> ${row.sourceFile}`);
    return [`route:${result.route} rendering=${result.rendering} source=${result.sourceFile} deps=${(result.dependencies ?? []).length}`];
  }
  // memory_context returns one of several discriminated packs.
  if (Array.isArray(result.items)) return result.items.map((item:any)=>`${item.type}:${item.subject} [${(item.channels ?? []).join("+")}]`);
  if (Array.isArray(result.steps)) return result.steps.map((step:any)=>`${step.relation ?? step.via}:${step.to ?? step.affected}`);
  if (Array.isArray(result.relations)) return result.relations.map((row:any)=>`${row.relation}:${row.affected}`);
  if (Array.isArray(result.exemplars)) return result.exemplars.map((row:any)=>`${row.type ?? "fact"}:${row.subject}`);
  if (Array.isArray(result.facts)) return result.facts.map((row:any)=>`${row.type ?? "fact"}:${row.subject}`);
  if (Array.isArray(result.decisions)) return result.decisions.map((row:any)=>`decision:${row.decision_key ?? row.title}`);
  if (Array.isArray(result.changes)) return result.changes.map((row:any)=>`change:${row.entity}`);
  return [`pack:${result.kind ?? "unknown"}`];
}

interface FileFactSummary { file:string; focusedTypes:string[]; broadTypes:string[]; }

/** What the store actually knows about a file, split by evidence breadth. */
function factsForFile(memoryDb:MemoryDatabase,repository:string,file:string):FileFactSummary {
  const rows=memoryDb.db.prepare(`
    SELECT m.memory_type type,(SELECT COUNT(*) FROM memory_evidence x WHERE x.memory_id=m.id) breadth
    FROM memories m JOIN memory_evidence e ON e.memory_id=m.id JOIN repositories repo ON repo.id=m.repository_id
    WHERE m.active=1 AND repo.name=? AND e.file_path=? GROUP BY m.id
  `).all(repository,file) as Array<{type:string;breadth:number}>;
  return {
    file,
    focusedTypes:[...new Set(rows.filter((row)=>row.breadth<=FOCUSED_EVIDENCE_MAX).map((row)=>row.type))],
    broadTypes:[...new Set(rows.filter((row)=>row.breadth>FOCUSED_EVIDENCE_MAX).map((row)=>row.type))],
  };
}

function typesWithNoMemory(memoryDb:MemoryDatabase,repository:string,types:string[]):string[] {
  return types.filter((type)=>{
    const row=memoryDb.db.prepare(`
      SELECT COUNT(*) c FROM memories m JOIN repositories repo ON repo.id=m.repository_id
      WHERE m.active=1 AND repo.name=? AND m.memory_type=?
    `).get(repository,type) as {c:number};
    return row.c===0;
  });
}

/** Severity order: a false assertion outranks a gap, a gap outranks bad ordering. */
const CLASS_SEVERITY=["unsupported-inference","wrong-intent","agent-policy","missing-fact","ranking"];

/** Why one expected evidence file never reached the pack. */
function classifyMissingFile(file:FileFactSummary,inferredTypes:string[]):string {
  if (!file.focusedTypes.length) return "missing-fact";
  if (inferredTypes.length && !file.focusedTypes.some((type)=>inferredTypes.includes(type))) return "wrong-intent";
  return "ranking";
}

/**
 * Deterministic primary-cause rule.
 *
 * Ordered so an upstream cause always wins: an asserted falsehood outranks
 * everything, a query that never selected the right channel cannot be blamed on
 * ranking, and ranking cannot be blamed for a fact that was never extracted.
 * A case with no failure signal is classified as clean even when a warning
 * fired, so a correct answer is never counted as a miss.
 */
function classifyMiss(input:{
  policy:string;
  /** The pack said, in its own contract, that it cannot fully answer. */
  declaredInsufficient:boolean;
  forbiddenInPack:string[];
  emptyPack:boolean;
  returnedItems:number;
  inferredTypes:string[];
  deadTypes:string[];
  routeMisparse:boolean;
  missingFiles:FileFactSummary[];
  noiseCount:number;
}):{primary:string|null;secondary:string[];perFile:Array<{file:string;class:string}>;reason:string} {
  const perFile=input.missingFiles.map((file)=>({file:file.file,class:classifyMissingFile(file,input.inferredTypes)}));
  const warnings:string[]=[];
  if (input.noiseCount>=3) warnings.push("over-retrieval");
  if (input.missingFiles.some((file)=>!file.focusedTypes.length && file.broadTypes.length)) warnings.push("missing-relation");
  if (input.routeMisparse) warnings.push("route-misparse");

  if (input.forbiddenInPack.length) {
    return {primary:"unsupported-inference",secondary:warnings,perFile,reason:`the pack asserts ${input.forbiddenInPack.join(", ")}, which the source contradicts`};
  }
  // A pack may return supporting facts and still abstain correctly; what matters is
  // whether it declared its own insufficiency. Counting items alone flagged packs
  // that were behaving exactly as the policy requires. This is checked before the
  // empty-pack rule, because an empty pack that declares why it is empty is the
  // correct answer to a question the repository cannot support.
  if (input.policy==="abstain" || input.policy==="report-gap") {
    if (input.declaredInsufficient) return {primary:null,secondary:warnings,perFile,reason:`policy ${input.policy} satisfied: the pack declared its own insufficiency`};
    return {primary:"agent-policy",secondary:warnings,perFile,
      reason:`policy is ${input.policy} but the pack declared no insufficiency (returned ${input.returnedItems} item(s))`};
  }
  if (input.emptyPack) {
    return input.deadTypes.length
      ? {primary:"wrong-intent",secondary:warnings,perFile,reason:`type filter [${input.inferredTypes.join(", ")}] has zero memories in this repository; pack came back empty`}
      : {primary:"missing-fact",secondary:warnings,perFile,reason:"pack came back empty and no type filter explains it"};
  }
  if (!perFile.length) {
    return {primary:null,secondary:warnings,perFile,reason:warnings.length ? `expected evidence complete; warnings: ${warnings.join(", ")}` : "expected evidence complete"};
  }
  if (input.routeMisparse) {
    return {primary:"wrong-intent",secondary:warnings,perFile,reason:"a file path or prose fragment was parsed as an HTTP route and drove the SQL channel"};
  }
  const counts=perFile.reduce((totals:Record<string,number>,entry)=>{
    totals[entry.class]=(totals[entry.class] ?? 0)+1;
    return totals;
  },{});
  const primary=Object.keys(counts).sort((a,b)=>
    counts[b]!-counts[a]! || CLASS_SEVERITY.indexOf(a)-CLASS_SEVERITY.indexOf(b),
  )[0]!;
  return {
    primary,
    secondary:[...warnings,...Object.keys(counts).filter((key)=>key!==primary)],
    perFile,
    reason:Object.entries(counts).map(([key,count])=>`${count} file(s) ${key}`).join(", "),
  };
}

/** The agent-facing surface is three tools (RCE-019); the suite must exercise that surface and no other. */
async function callTool(tools:MemoryTools,repository:string,question:string,step:PlanStep):Promise<any> {
  const args=step.args ?? {};
  if (step.tool==="memory_repository") return tools.repository(repository);
  if (step.tool==="memory_route") return args.route ? tools.route(repository,args.route) : tools.routes(repository,args.limit ?? 50);
  return tools.context(question,{repository,maxChars:args.maxChars});
}

export async function runContextEvaluation(memoryDb:MemoryDatabase,file:string):Promise<any> {
  const absolute=path.resolve(file);
  const suite=await readJson<ContextEvalSuite>(absolute);
  if (!suite?.cases?.length) throw new Error(`Context evaluation has no cases: ${absolute}`);

  const tools=new MemoryTools(memoryDb);
  const repoConfig=await getRepositoryConfig(suite.repository);
  const headSha=await getHeadSha(repoConfig.path);
  const workingTree=await getWorkingTreeStatus(repoConfig.path);
  const discovery=await discoveryChars(repoConfig.path);
  const indexedSha=tools.repository(suite.repository).lastIndexedSha as string;

  const cases=[];
  for (const item of suite.cases) {
    const started=Date.now();
    const steps=[];
    let engineChars=0;
    let payload="";
    let failed:string|null=null;
    let contextPack:any=null;
    for (const step of item.plan) {
      const stepStarted=Date.now();
      try {
        const result=await callTool(tools,suite.repository,item.question,step);
        // The richest pack, not the last step: a plan may end on a plain profile lookup.
        if (result?.answerContract||result?.verification||Array.isArray(result?.decisions)) contextPack=result;
        const serialized=JSON.stringify(result);
        engineChars+=serialized.length;
        payload+=serialized;
        steps.push({tool:step.tool,args:step.args ?? {},chars:serialized.length,tokens:tokensFor(serialized.length),latencyMs:Date.now()-stepStarted,ok:true,returned:summarizeResult(step.tool,result)});
      } catch (error) {
        failed=(error as Error).message;
        steps.push({tool:step.tool,args:step.args ?? {},chars:0,tokens:0,latencyMs:Date.now()-stepStarted,ok:false,error:failed});
      }
    }

    const cited=citedFiles(payload);
    const returnedItemCount=steps.reduce((sum,step)=>sum+(step.returned?.length ?? 0),0);
    const found=item.expectedEvidence.filter((expected)=>payload.includes(expected));
    const missing=item.expectedEvidence.filter((expected)=>!payload.includes(expected));
    const noise=cited.filter((candidate)=>!item.expectedEvidence.includes(candidate));

    const understood=understandQuery(item.question,{repo:suite.repository});
    const inferredTypes=(understood.memoryTypes ?? []) as string[];
    const knownRoutes=new Set((tools.routes(suite.repository,100).routes as any[]).map((row)=>row.route));
    const missingFacts=missing.map((relative)=>factsForFile(memoryDb,suite.repository,relative));
    // Read from the pack's own contract rather than inferred from its size.
    const uncertainty=contextPack?.answerContract?.uncertainty;
    const declaredInsufficient=Boolean(
      (uncertainty?.level&&uncertainty.level!=="none")
      || (uncertainty?.reasons?.length)
      || (contextPack?.verification?.gaps?.length)
      || (Array.isArray(contextPack?.gaps)&&contextPack.gaps.length),
    );

    const classification=classifyMiss({
      policy:item.policy,
      declaredInsufficient,
      forbiddenInPack:(item.packForbidden ?? []).filter((pattern)=>payload.includes(pattern)),
      returnedItems:returnedItemCount,
      emptyPack:returnedItemCount===0,
      inferredTypes,
      deadTypes:typesWithNoMemory(memoryDb,suite.repository,inferredTypes),
      routeMisparse:Boolean(understood.route) && !knownRoutes.has(understood.route!),
      missingFiles:missingFacts,
      noiseCount:noise.length,
    });

    let baselineChars=discovery;
    for (const relative of item.baselineReadSet) baselineChars+=await fileChars(repoConfig.path,relative);

    cases.push({
      caseId:item.id,
      job:item.job,
      strict:item.strict,
      policy:item.policy,
      question:item.question,
      strictFact:item.strictFact,
      forbiddenClaims:item.forbiddenClaims,
      steps,
      toolCalls:steps.length,
      engine:{chars:engineChars,tokens:tokensFor(engineChars),latencyMs:Date.now()-started,error:failed},
      baseline:{
        files:item.baselineReadSet.length,
        chars:baselineChars,
        tokens:tokensFor(baselineChars),
        discoveryChars:discovery,
      },
      contextSavingPercent:baselineChars ? Number((((baselineChars-engineChars)/baselineChars)*100).toFixed(1)) : null,
      evidence:{
        expected:item.expectedEvidence.length,
        found:found.length,
        recall:item.expectedEvidence.length ? Number((found.length/item.expectedEvidence.length).toFixed(4)) : null,
        missing,
        citedButNotExpected:noise,
      },
      diagnosis:{
        inferredTypes,
        inferredRoute:understood.route ?? null,
        routeExists:understood.route ? knownRoutes.has(understood.route) : null,
        channels:understood.channels,
        deadTypeFilter:typesWithNoMemory(memoryDb,suite.repository,inferredTypes),
        missingFileFacts:missingFacts,
        declaredInsufficient,
        primaryMissClass:classification.primary,
        secondaryMissClasses:classification.secondary,
        perFileMissClass:classification.perFile,
        forbiddenClaimsInPack:(item.packForbidden ?? []).filter((pattern)=>payload.includes(pattern)),
        reason:classification.reason,
      },
      // Filled by a human/agent scoring pass; the harness never guesses answer quality.
      answerScore:{taskCorrect:null,groundedClaims:null,unsupportedClaims:null,fallback:null,notes:""},
    });
  }

  const withRecall=cases.filter((item)=>item.evidence.recall!==null);
  const savings=cases.map((item)=>item.contextSavingPercent).filter((value):value is number=>value!==null).sort((a,b)=>a-b);

  return {
    suite:suite.suite,
    file:absolute,
    repository:suite.repository,
    targetSha:suite.targetSha,
    headSha,
    indexedSha,
    shaMatchesTarget:headSha===suite.targetSha && indexedSha===suite.targetSha,
    workingTreeDirty:workingTree.length>0,
    workingTreeStatus:workingTree,
    ranAt:new Date().toISOString(),
    totals:{
      cases:cases.length,
      toolCalls:cases.reduce((sum,item)=>sum+item.toolCalls,0),
      engineTokens:cases.reduce((sum,item)=>sum+item.engine.tokens,0),
      baselineTokens:cases.reduce((sum,item)=>sum+item.baseline.tokens,0),
      baselineSourceFiles:cases.reduce((sum,item)=>sum+item.baseline.files,0),
      meanEvidenceRecall:withRecall.length ? Number((withRecall.reduce((sum,item)=>sum+(item.evidence.recall ?? 0),0)/withRecall.length).toFixed(4)) : null,
      medianContextSavingPercent:savings.length ? savings[Math.floor(savings.length/2)]! : null,
      missClassCounts:cases.reduce((counts:Record<string,number>,item)=>{
        const key=item.diagnosis.primaryMissClass ?? "none";
        counts[key]=(counts[key] ?? 0)+1;
        return counts;
      },{}),
    },
    cases,
  };
}
