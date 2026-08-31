import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { getRepositoryConfig, projectRoot } from "./config.js";
import { MemoryDatabase } from "./memory/database.js";
import { MemoryStore } from "./memory/store.js";
import { AnswerFeedback } from "./telemetry/answer-feedback.js";
import { RetrievalTelemetry } from "./telemetry/retrieval-telemetry.js";
import { hybridSearch } from "./retrieval/search.js";
import { fullIndex, incrementalSync } from "./sync/sync.js";
import { startReconciliationScheduler } from "./sync/reconcile.js";
import { evaluateFreshness } from "./retrieval/freshness.js";
import { extractSymbolGraph } from "./analyzers/symbol-graph.js";
import { routeEntriesFrom, traceFlow } from "./retrieval/flow.js";
import { ProjectionCache } from "./ui/projection.js";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status,{"content-type":"application/json; charset=utf-8"});
  res.end(JSON.stringify(body,null,2));
}

async function body(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[]=[];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const UI_TYPES:Record<string,string>={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",
  ".js":"text/javascript; charset=utf-8",".svg":"image/svg+xml",".json":"application/json; charset=utf-8"};

/** Serves the browser UI from `public/`, which sits next to both `src/` and `dist/`. */
async function serveUi(res:http.ServerResponse,pathname:string):Promise<boolean> {
  const relative=pathname==="/"||pathname==="/ui"||pathname==="/ui/" ? "index.html" : pathname.replace(/^\/ui\//,"");
  if (relative.includes("..")) return false;
  const file=path.join(projectRoot(),"public",relative);
  try {
    const content=await readFile(file);
    res.writeHead(200,{"content-type":UI_TYPES[path.extname(file)] ?? "application/octet-stream","cache-control":"no-store"});
    res.end(content);
    return true;
  } catch { return false; }
}

/** The symbol graph is derived from the checkout, so it is cached per repository. */
const graphCache=new Map<string,Promise<{edges:Awaited<ReturnType<typeof extractSymbolGraph>>;routeFiles:Map<string,string>}>>();

let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(job, job);
  writeQueue = next.then(() => undefined, () => undefined);
  return next;
}

export function startServer(memoryDb = new MemoryDatabase()): http.Server {
  const store = new MemoryStore(memoryDb);
  const feedback = new AnswerFeedback(memoryDb);
  const telemetry = new RetrievalTelemetry(memoryDb);
  const projections = new ProjectionCache(memoryDb);
  const host = process.env.MEMORY_HOST ?? "127.0.0.1";
  const port = Number(process.env.MEMORY_PORT ?? 4317);

  const server = http.createServer(async (req,res) => {
    try {
      const url = new URL(req.url ?? "/",`http://${req.headers.host ?? "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") return json(res,200,{ok:true,vectorEnabled:memoryDb.vectorEnabled});

      // ---- browser UI ----
      if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/ui"))) {
        if (await serveUi(res,url.pathname)) return;
      }
      if (req.method === "GET" && url.pathname === "/api/ui/projects") {
        const repositories=[];
        for (const repository of store.listRepositories() as any[]) {
          let freshness:any=null;
          try { freshness=await evaluateFreshness(memoryDb,repository.name); } catch { /* path may be unavailable */ }
          const quality=store.qualityReport(repository.name) as any;
          repositories.push({
            name:repository.name,framework:repository.framework,nextVersion:repository.next_version,
            reactVersion:repository.react_version,router:repository.router_type,
            lastIndexedSha:repository.last_indexed_sha,lastIndexedAt:repository.last_indexed_at,
            facts:quality.activeMemories,vectors:quality.vectors,routes:quality.routes,
            duplicationRatio:quality.duplicationRatio,evidenceCoverage:quality.evidenceCoverage,
            symbolCoverage:quality.symbolCoverage,unreadConfigKeys:quality.unreadConfigKeys,
            freshness:freshness ? {state:freshness.state,driftCommits:freshness.driftCommits,
              workingTreeDirty:freshness.workingTreeDirty,guidance:freshness.answerGuidance} : null,
          });
        }
        return json(res,200,{vectorEnabled:memoryDb.vectorEnabled,repositories});
      }
      const projectionMatch=url.pathname.match(/^\/api\/ui\/projection\/([^/]+)$/);
      if (req.method === "GET" && projectionMatch) {
        try { return json(res,200,projections.get(decodeURIComponent(projectionMatch[1]!))); }
        catch (error) { return json(res,404,{error:(error as Error).message}); }
      }
      const neighbourMatch=url.pathname.match(/^\/api\/ui\/neighbours\/([^/]+)$/);
      if (req.method === "GET" && neighbourMatch) {
        const id=Number(url.searchParams.get("id"));
        if (!Number.isInteger(id)) return json(res,400,{error:"id is required"});
        return json(res,200,{id,neighbours:projections.neighbours(decodeURIComponent(neighbourMatch[1]!),id,
          Number(url.searchParams.get("limit") ?? 6))});
      }
      const vectorSearchMatch=url.pathname.match(/^\/api\/ui\/vector-search\/([^/]+)$/);
      if (req.method === "GET" && vectorSearchMatch) {
        const query=url.searchParams.get("q") ?? "";
        if (query.trim().length<2) return json(res,400,{error:"q must be at least 2 characters"});
        if (!memoryDb.vectorEnabled) return json(res,409,{error:"vector search is disabled in this index"});
        const { embedQuery }=await import("./memory/embeddings.js");
        const vector=await embedQuery(query);
        return json(res,200,{query,matches:projections.search(decodeURIComponent(vectorSearchMatch[1]!),vector,
          Number(url.searchParams.get("limit") ?? 6))});
      }
      const flowMatch=url.pathname.match(/^\/api\/ui\/flow\/([^/]+)$/);
      if (req.method === "GET" && flowMatch) {
        const repository=decodeURIComponent(flowMatch[1]!);
        const config=await getRepositoryConfig(repository);
        const routes=store.listRoutes(repository) as any[];
        if (!graphCache.has(repository)) {
          graphCache.set(repository,(async()=>{
            // Same file set the indexer uses, so generated output stays out of the graph.
            const { listAnalyzableSourceFiles }=await import("./analyzers/source-memory.js");
            const files=(await listAnalyzableSourceFiles(config.path)).filter((file)=>/\.(ts|tsx)$/.test(file));
            const routeFiles=new Map(routes.map((route)=>[route.route as string,route.source_file as string]));
            return {edges:await extractSymbolGraph(config.path,files,[...routeFiles.keys()]),routeFiles};
          })());
        }
        const { edges, routeFiles }=await graphCache.get(repository)!;
        const seed=url.searchParams.get("seed")
          ?? edges.find((edge)=>edge.type==="submits-to")?.from
          ?? edges.find((edge)=>edge.from.includes("#"))?.from;
        if (!seed) return json(res,200,{seed:null,steps:[],endpoints:[],config:[],prunedSteps:0,entryPoints:[]});
        const trace=traceFlow(edges,seed,{routeEntries:routeEntriesFrom(edges,routeFiles),maxSteps:24});
        const entryPoints=[...new Set(edges.filter((edge)=>edge.type==="submits-to"||/#(?:handleSubmit|POST|GET)$/.test(edge.from))
          .map((edge)=>edge.from))].slice(0,12);
        return json(res,200,{...trace,entryPoints,totalEdges:edges.length,
          edgeTypes:edges.reduce((counts:Record<string,number>,edge)=>{counts[edge.type]=(counts[edge.type] ?? 0)+1;return counts;},{})});
      }

      if (req.method === "GET" && url.pathname === "/repositories") return json(res,200,store.listRepositories());
      if (req.method === "GET" && url.pathname === "/quality") return json(res,200,store.qualityReport(url.searchParams.get("repo") ?? undefined));
      if (req.method === "GET" && url.pathname === "/telemetry") return json(res,200,telemetry.report(url.searchParams.get("repo") ?? undefined));
      if (req.method === "GET" && url.pathname === "/feedback") {
        const repo=url.searchParams.get("repo") ?? undefined;
        return json(res,200,{summary:feedback.summary(repo),backlog:feedback.backlog(repo)});
      }
      if (req.method === "POST" && url.pathname === "/feedback") {
        const payload=await body(req);
        try { return json(res,201,feedback.record({...payload,reporter:payload.reporter ?? "http"})); }
        catch (error) { return json(res,400,{error:(error as Error).message}); }
      }
      if (req.method === "GET" && url.pathname === "/search") {
        const q=url.searchParams.get("q") ?? "";
        if (!q) return json(res,400,{error:"q is required"});
        return json(res,200,await hybridSearch(memoryDb,q,{repo:url.searchParams.get("repo") ?? undefined,limit:Number(url.searchParams.get("limit") ?? 10)}));
      }
      const routeMatch=url.pathname.match(/^\/repositories\/([^/]+)\/routes$/);
      if (req.method === "GET" && routeMatch) return json(res,200,store.listRoutes(decodeURIComponent(routeMatch[1]!)));
      const dependencyMatch=url.pathname.match(/^\/repositories\/([^/]+)\/dependencies$/);
      if (req.method === "GET" && dependencyMatch) return json(res,200,store.listDependencies(decodeURIComponent(dependencyMatch[1]!)));
      const routeDependencyMatch=url.pathname.match(/^\/repositories\/([^/]+)\/route-dependencies$/);
      if (req.method === "GET" && routeDependencyMatch) return json(res,200,store.listRouteDependencies(decodeURIComponent(routeDependencyMatch[1]!),url.searchParams.get("route") ?? undefined));
      const changesMatch=url.pathname.match(/^\/repositories\/([^/]+)\/changes$/);
      if (req.method === "GET" && changesMatch) return json(res,200,store.listMemoryChanges(decodeURIComponent(changesMatch[1]!),url.searchParams.get("since") ?? undefined));
      const profileMatch=url.pathname.match(/^\/repositories\/([^/]+)$/);
      if (req.method === "GET" && profileMatch) {
        const repo=store.getRepository(decodeURIComponent(profileMatch[1]!));
        return repo ? json(res,200,repo) : json(res,404,{error:"repository not found"});
      }
      if (req.method === "POST" && (url.pathname === "/sync" || url.pathname === "/full-index")) {
        const payload=await body(req);
        if (!payload.repository) return json(res,400,{error:"repository is required"});
        if (typeof payload.commit !== "string" || !/^[0-9a-f]{40}$/i.test(payload.commit)) return json(res,400,{error:"commit must be a full 40-character Git SHA"});
        const config=await getRepositoryConfig(payload.repository);
        const options={expectedCommit:payload.commit};
        const result=await enqueue(() => url.pathname === "/sync" ? incrementalSync(config,memoryDb,options) : fullIndex(config,memoryDb,options));
        return json(res,200,result);
      }
      json(res,404,{error:"not found"});
    } catch (error) {
      json(res,500,{error:(error as Error).message});
    }
  });
  const stopScheduler=startReconciliationScheduler(memoryDb,enqueue);
  server.on("close",stopScheduler);
  server.listen(port,host,()=>console.log(`[memory] server listening on http://${host}:${port}`));
  return server;
}
