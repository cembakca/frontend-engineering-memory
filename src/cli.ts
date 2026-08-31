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

function help(): void {
  console.log(`Frontend Engineering Memory\n\nCommands:\n  repos\n  status\n  full <repository>\n  full-all\n  sync <repository>\n  sync-all\n  reconcile <repository>\n  reconcile-all\n  ai-extract <repository> [--file=src/path.ts]\n  routes <repository>\n  dependencies <repository>\n  route-dependencies <repository> [--route=/path]\n  changes <repository> [--since=<commit>]\n  search <query> [--repo=<repository>] [--limit=10]\n  quality [repository]\n  evaluate [evaluation.json]\n  serve\n`);
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
    } else help();
  } finally {
    if (command !== "serve") memoryDb.close();
  }
}

main().catch((error)=>{ console.error(`[memory] ${error.message}`); process.exitCode=1; });
