import path from "node:path";
import { getRepositoryConfig, loadRegistry, projectRoot } from "./config.js";
import { MemoryDatabase } from "./memory/database.js";
import { MemoryStore } from "./memory/store.js";
import { rebuildVectors } from "./memory/vectorize.js";
import { hybridSearch } from "./retrieval/search.js";
import { startServer } from "./server.js";
import { fullIndex, incrementalSync } from "./sync/sync.js";
import { runAiExtraction } from "./sync/ai-extract.js";
import { reconcileAll } from "./sync/reconcile.js";
import { runContextEvaluation } from "./retrieval/context-eval.js";
import { runEvaluationFleet, scaffoldEvaluationOverlay } from "./retrieval/evaluation-fleet.js";
import { runContextEconomy } from "./retrieval/context-economy.js";
import { RetrievalTelemetry } from "./telemetry/retrieval-telemetry.js";
import { AnswerFeedback, type BacklogState, type FeedbackSignal } from "./telemetry/answer-feedback.js";
import { evaluateFreshness } from "./retrieval/freshness.js";
import { runSecurityAudit } from "./security/audit.js";
import { evaluateSecondPilotGate } from "./rollout/pilot-gate.js";
import { evaluateRollout } from "./rollout/rollout-plan.js";
import { TemporalContextEngine } from "./retrieval/temporal.js";
import { TaskContextCompiler } from "./retrieval/task-context.js";
import { readJson } from "./utils/fs.js";
import type { DecisionInput } from "./memory/decisions.js";
import { onboardRepository } from "./onboarding/onboard.js";

function help(): void {
  console.log(`Frontend Engineering Memory

Commands:
  repos
  onboard [repository|--all] [--evaluate]
  status
  full <repository> | full-all
  sync <repository> | sync-all
  reconcile <repository> | reconcile-all
  routes <repository>
  dependencies <repository>
  search <query> [--repo=<repository>] [--limit=10]
  quality [repository]
  context-eval-all [evaluation-fleet.json] [--validate-only]
  eval-scaffold <repository> --family=<content-site|product-app>
  freshness [repository]
  security-audit [repository]
  serve

Run a command with its required arguments; see docs/PROJECT_GUIDE.md for advanced commands.`);
}

async function main(): Promise<void> {
  const [command,...args]=process.argv.slice(2);
  if (!command || command === "help" || command === "--help") return help();
  const memoryDb=new MemoryDatabase();
  const store=new MemoryStore(memoryDb);

  if (command === "serve") { startServer(memoryDb); return; }
  try {
    if (command === "repos") {
      const registry=await loadRegistry();
      console.table(registry.repositories.map((r)=>({name:r.name,path:r.path,branch:r.mainBranch ?? "main"})));
    } else if (command === "onboard") {
      const requested=args.find((item)=>!item.startsWith("--"));
      const registry=await loadRegistry();
      const fleetManifest=await readJson<any>(path.join(projectRoot(),"config/evaluation-fleet.json"));
      const assigned=new Set((fleetManifest?.repositories ?? []).map((item:any)=>item.repository));
      const names=requested ? [requested] : registry.repositories
        .map((item)=>item.name).filter((name)=>args.includes("--all")||!store.getRepository(name)||!assigned.has(name));
      const batch=names.length>1;
      const results=[];
      for (const name of names) {
        try {
          results.push({ok:true,...await onboardRepository(memoryDb,name,{
            evaluate:args.includes("--evaluate")&&!batch,
            validateFleet:!batch,
          })});
        } catch (error) { results.push({ok:false,repository:name,error:(error as Error).message}); }
      }
      const fleet=batch
        ? await runEvaluationFleet(memoryDb,path.join(projectRoot(),"config/evaluation-fleet.json"),{validateOnly:!args.includes("--evaluate")})
        : results[0]?.fleet ?? null;
      console.log(JSON.stringify({processed:results.length,results,fleet},null,2));
      if (results.some((item:any)=>!item.ok)||fleet?.decision==="hold") process.exitCode=1;
    } else if (command === "status") {
      console.table(store.listRepositories().map((r:any)=>({name:r.name,next:r.next_version,router:r.router_type,lastSha:r.last_indexed_sha,indexedAt:r.last_indexed_at})));
    } else if (command === "full" || command === "sync" || command === "reconcile") {
      const name=args[0]; if (!name) throw new Error("repository name is required");
      const config=await getRepositoryConfig(name);
      console.log(JSON.stringify(command === "sync" ? await incrementalSync(config,memoryDb) : await fullIndex(config,memoryDb),null,2));
    } else if (command === "full-all" || command === "sync-all") {
      const registry=await loadRegistry();
      const results=[];
      for (const item of registry.repositories) {
        const config={...item,path:(await getRepositoryConfig(item.name)).path,mainBranch:item.mainBranch ?? "main"};
        try {
          const result=command === "full-all" ? await fullIndex(config,memoryDb) : await incrementalSync(config,memoryDb);
          results.push({repository:item.name,ok:true,result});
        } catch (error) {
          results.push({repository:item.name,ok:false,error:(error as Error).message});
        }
      }
      console.log(JSON.stringify(results,null,2));
      if (results.some((item)=>!item.ok)) process.exitCode=1;
    } else if (command === "reconcile-all") {
      const results=await reconcileAll(memoryDb);
      console.log(JSON.stringify(results,null,2));
      if (results.some((item)=>!item.ok)) process.exitCode=1;
    } else if (command === "ai-extract") {
      const name=args[0]; if (!name) throw new Error("repository name is required");
      const sourceFiles=args.filter((item)=>item.startsWith("--file=")).map((item)=>item.slice(7));
      console.log(JSON.stringify(await runAiExtraction(await getRepositoryConfig(name),memoryDb,{sourceFiles:sourceFiles.length ? sourceFiles : undefined}),null,2));
    } else if (command === "routes") {
      const name=args[0]; if (!name) throw new Error("repository name is required");
      console.table(store.listRoutes(name).map((r:any)=>({route:r.route,router:r.router_type,type:r.route_type,rendering:r.rendering_mode,source:r.source_file})));
    } else if (command === "dependencies") {
      const name=args[0]; if (!name) throw new Error("repository name is required");
      console.table(store.listDependencies(name));
    } else if (command === "route-dependencies") {
      const name=args[0]; if (!name) throw new Error("repository name is required");
      const routeArg=args.find((x)=>x.startsWith("--route="));
      console.table(store.listRouteDependencies(name,routeArg?.slice(8)));
    } else if (command === "changes") {
      const name=args[0]; if (!name) throw new Error("repository name is required");
      const sinceArg=args.find((x)=>x.startsWith("--since="));
      console.log(JSON.stringify(store.listMemoryChanges(name,sinceArg?.slice(8)),null,2));
    } else if (command === "snapshots") {
      const name=args[0]; if (!name) throw new Error("repository name is required");
      console.log(JSON.stringify(store.listRepositorySnapshots(name),null,2));
    } else if (command === "behavior-diff") {
      const name=args[0]; if (!name) throw new Error("repository name is required");
      const from=args.find((item)=>item.startsWith("--from="))?.slice(7);
      const to=args.find((item)=>item.startsWith("--to="))?.slice(5);
      if (!from||!to) throw new Error("behavior-diff requires --from=<sha> and --to=<sha>");
      console.log(JSON.stringify(new TemporalContextEngine(store).behaviorDiff(name,from,to),null,2));
    } else if (command === "context-at") {
      const name=args[0]; if (!name) throw new Error("repository name is required");
      const sha=args.find((item)=>item.startsWith("--sha="))?.slice(6); if (!sha) throw new Error("context-at requires --sha=<sha>");
      const question=args.slice(1).filter((item)=>!item.startsWith("--sha=")).join(" "); if (!question) throw new Error("context-at question is required");
      console.log(JSON.stringify(await new TaskContextCompiler(memoryDb).compile(question,{repository:name,atSha:sha}),null,2));
    } else if (command === "decisions") {
      const name=args[0]; if (!name) throw new Error("repository name is required");
      console.log(JSON.stringify(store.listRepositoryDecisions(name,args.slice(1).join(" ")||undefined),null,2));
    } else if (command === "decision-add") {
      const name=args[0]; if (!name) throw new Error("repository name is required");
      const file=args.find((item)=>item.startsWith("--file="))?.slice(7); if (!file) throw new Error("decision-add requires --file=<decision.json>");
      const decision=await readJson<DecisionInput>(path.resolve(file)); if (!decision) throw new Error(`Decision file not found or invalid JSON: ${file}`);
      console.log(JSON.stringify({id:store.addRepositoryDecision(name,decision)},null,2));
    } else if (command === "search") {
      const repoArg=args.find((x)=>x.startsWith("--repo="));
      const limitArg=args.find((x)=>x.startsWith("--limit="));
      const query=args.filter((x)=>!x.startsWith("--repo=")&&!x.startsWith("--limit=")).join(" ");
      if (!query) throw new Error("search query is required");
      const rows=await hybridSearch(memoryDb,query,{repo:repoArg?.slice(7),limit:limitArg?Number(limitArg.slice(8)):10});
      console.log(JSON.stringify(rows,null,2));
    } else if (command === "quality") {
      console.log(JSON.stringify(store.qualityReport(args[0]),null,2));
    } else if (command === "embedding-status") {
      console.log(JSON.stringify({
        enabled:memoryDb.vectorEnabled,profile:memoryDb.embeddingProfile.id,model:memoryDb.embeddingProfile.model,
        revision:memoryDb.embeddingProfile.revision,dimension:memoryDb.vectorDimension,
        dtype:memoryDb.embeddingProfile.dtype,vectorTable:memoryDb.vectorTableName,
        repositories:store.listRepositories().map((row:any)=>({name:row.name,...store.qualityReport(row.name)})),
      },null,2));
    } else if (command === "vectors") {
      console.log(JSON.stringify(await rebuildVectors(memoryDb,args[0]),null,2));
    } else if (command === "context-eval") {
      const file=args[0] ?? path.join(projectRoot(),"config/context-engine-eval.json");
      console.log(JSON.stringify(await runContextEvaluation(memoryDb,file),null,2));
    } else if (command === "context-eval-all") {
      const file=args.find((item)=>!item.startsWith("--")) ?? path.join(projectRoot(),"config/evaluation-fleet.json");
      const result=await runEvaluationFleet(memoryDb,file,{validateOnly:args.includes("--validate-only")});
      console.log(JSON.stringify(result,null,2));
      if (result.decision==="hold") process.exitCode=1;
    } else if (command === "eval-scaffold") {
      const name=args[0]; if (!name) throw new Error("repository name is required");
      const family=args.find((item)=>item.startsWith("--family="))?.slice(9); if (!family) throw new Error("eval-scaffold requires --family=<family>");
      console.log(JSON.stringify(scaffoldEvaluationOverlay(memoryDb,name,family),null,2));
    } else if (command === "telemetry") {
      const telemetry=new RetrievalTelemetry(memoryDb);
      const name=args.find((x)=>!x.startsWith("--"));
      if (args.includes("--prune")) { console.log(JSON.stringify({pruned:telemetry.prune()},null,2)); return; }
      const limitArg=args.find((x)=>x.startsWith("--limit="));
      const recentArg=args.find((x)=>x.startsWith("--recent="));
      console.log(JSON.stringify({
        report:telemetry.report(name,limitArg?Number(limitArg.slice(8)):200),
        recent:telemetry.recent(name,recentArg?Number(recentArg.slice(9)):20),
      },null,2));
    } else if (command === "rollout-status") {
      const flag=(name:string)=>args.find((x)=>x.startsWith(`--${name}=`))?.slice(name.length+3);
      const report=await evaluateRollout(memoryDb,{evalRun:flag("run"),economyRun:flag("economy")});
      console.log(JSON.stringify(report,null,2));
      if (report.decision!=="advance") process.exitCode=1;
    } else if (command === "pilot-gate") {
      const flag=(name:string)=>args.find((x)=>x.startsWith(`--${name}=`))?.slice(name.length+3);
      const report=await evaluateSecondPilotGate(memoryDb,{candidate:flag("candidate"),evalRun:flag("run"),economyRun:flag("economy")});
      console.log(JSON.stringify(report,null,2));
      if (report.decision!=="open") process.exitCode=1;
    } else if (command === "security-audit") {
      const report=await runSecurityAudit(memoryDb,{repository:args[0]});
      console.log(JSON.stringify(report,null,2));
      if (!report.ok) process.exitCode=1;
    } else if (command === "freshness") {
      const registry=await loadRegistry();
      const names=args[0] ? [args[0]] : registry.repositories.map((item)=>item.name);
      const reports=[];
      for (const name of names) {
        try { reports.push(await evaluateFreshness(memoryDb,name)); }
        catch (error) { reports.push({repository:name,error:(error as Error).message}); }
      }
      console.log(JSON.stringify(args[0] ? reports[0] : reports,null,2));
    } else if (command === "feedback") {
      const feedback=new AnswerFeedback(memoryDb);
      const sub=args[0];
      const flag=(name:string)=>args.find((x)=>x.startsWith(`--${name}=`))?.slice(name.length+3);
      if (sub === "add") {
        const name=args[1]; if (!name) throw new Error("repository name is required");
        const signal=flag("signal") as FeedbackSignal|undefined; if (!signal) throw new Error("--signal is required");
        const event=flag("event");
        console.log(JSON.stringify(feedback.record({repository:name,signal,
          retrievalEventId:event?Number(event):null,query:flag("query") ?? null,
          note:flag("note") ?? null,reporter:flag("reporter") ?? "cli"}),null,2));
      } else if (sub === "backlog") {
        const name=args[1]&&!args[1].startsWith("--") ? args[1] : undefined;
        const limit=flag("limit");
        console.log(JSON.stringify({summary:feedback.summary(name),
          backlog:feedback.backlog(name,{state:flag("state") as BacklogState|undefined,limit:limit?Number(limit):undefined})},null,2));
      } else if (sub === "export") {
        const name=args[1]; if (!name||name.startsWith("--")) throw new Error("repository name is required");
        const limit=flag("limit");
        console.log(JSON.stringify(feedback.evaluationDraft(name,
          {state:flag("state") as BacklogState|undefined,limit:limit?Number(limit):undefined}),null,2));
      } else if (sub === "triage") {
        const hash=args[1]; if (!hash) throw new Error("queryHash is required");
        const signal=flag("signal") as FeedbackSignal|undefined; if (!signal) throw new Error("--signal is required");
        const state=flag("state") as BacklogState|undefined; if (!state) throw new Error("--state is required");
        console.log(JSON.stringify({updated:feedback.updateState(hash,signal,state,flag("case"))},null,2));
      } else throw new Error("feedback subcommand must be add, backlog, export or triage");
    } else if (command === "context-economy") {
      const runArg=args.find((x)=>x.startsWith("--run="));
      const policyArg=args.find((x)=>x.startsWith("--policy="));
      console.log(JSON.stringify(await runContextEconomy({run:runArg?.slice(6),policyFile:policyArg?.slice(9)}),null,2));
    } else help();
  } finally {
    if (command !== "serve") memoryDb.close();
  }
}

main().catch((error)=>{ console.error(`[memory] ${error.message}`); process.exitCode=1; });
