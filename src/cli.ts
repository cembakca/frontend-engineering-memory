import path from "node:path";
import { getRepositoryConfig, loadRegistry, projectRoot } from "./config.js";
import { MemoryDatabase } from "./memory/database.js";
import { MemoryStore } from "./memory/store.js";
import { hybridSearch } from "./retrieval/search.js";
import { startServer } from "./server.js";
import { fullIndex, incrementalSync } from "./sync/sync.js";
import { runAiExtraction } from "./sync/ai-extract.js";
import { reconcileAll } from "./sync/reconcile.js";
import { runRetrievalEvaluation } from "./retrieval/evaluate.js";
import { runContextEvaluation } from "./retrieval/context-eval.js";
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

function help(): void {
  console.log(`Frontend Engineering Memory\n\nCommands:\n  repos\n  status\n  full <repository>\n  full-all\n  sync <repository>\n  sync-all\n  reconcile <repository>\n  reconcile-all\n  ai-extract <repository> [--file=src/path.ts]\n  routes <repository>\n  dependencies <repository>\n  route-dependencies <repository> [--route=/path]\n  changes <repository> [--since=<commit>]\n  snapshots <repository>\n  behavior-diff <repository> --from=<sha> --to=<sha>\n  context-at <repository> --sha=<sha> <question>\n  decisions <repository> [query]\n  decision-add <repository> --file=<decision.json>\n  search <query> [--repo=<repository>] [--limit=10]\n  quality [repository]\n  evaluate [evaluation.json]\n  context-eval [evaluation.json]\n  context-economy [--run=<run.json>] [--policy=<AGENTS.md>]\n  telemetry [repository] [--recent=20] [--limit=200] [--prune]\n  freshness [repository]\n  security-audit [repository]\n  pilot-gate [--candidate=<repository>] [--run=<eval.json>] [--economy=<economy.json>]\n  rollout-status [--run=<eval.json>] [--economy=<economy.json>]\n  feedback add <repository> --signal=<sufficient|source-needed|wrong|stale> [--event=<id>] [--query=<text>] [--note=<text>] [--reporter=<who>]\n  feedback backlog [repository] [--state=<new|triaged|case-created|dismissed>] [--limit=50]\n  feedback triage <queryHash> --signal=<signal> --state=<state> [--case=<caseId>]\n  serve\n`);
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
    } else if (command === "reconcile-all") {
      console.log(JSON.stringify(await reconcileAll(memoryDb),null,2));
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
    } else if (command === "evaluate") {
      const file=args[0] ?? path.join(projectRoot(),"config/retrieval-evaluation.json");
      console.log(JSON.stringify(await runRetrievalEvaluation(memoryDb,file),null,2));
    } else if (command === "context-eval") {
      const file=args[0] ?? path.join(projectRoot(),"config/context-engine-eval.json");
      console.log(JSON.stringify(await runContextEvaluation(memoryDb,file),null,2));
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
      } else if (sub === "triage") {
        const hash=args[1]; if (!hash) throw new Error("queryHash is required");
        const signal=flag("signal") as FeedbackSignal|undefined; if (!signal) throw new Error("--signal is required");
        const state=flag("state") as BacklogState|undefined; if (!state) throw new Error("--state is required");
        console.log(JSON.stringify({updated:feedback.updateState(hash,signal,state,flag("case"))},null,2));
      } else throw new Error("feedback subcommand must be add, backlog or triage");
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
