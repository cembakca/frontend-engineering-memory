import { readFile, readdir } from "node:fs/promises";
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
import { startRegistrySupervisor } from "./sync/supervisor.js";
import { FreshnessCache } from "./retrieval/freshness.js";
import { routeEntriesFrom, traceFlow } from "./retrieval/flow.js";
import { createMemoryMcpHttpHandler } from "./mcp/server.js";
import { MemoryTools } from "./mcp/tools.js";
import { authenticateWebhook, parseWebhook, WebhookError } from "./webhook.js";
import { ProjectionCache } from "./ui/projection.js";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status,{"content-type":"application/json; charset=utf-8"});
  res.end(JSON.stringify(body,null,2));
}

function parseJson(value:unknown,fallback:any):any {
  try { return value ? JSON.parse(String(value)) : fallback; }
  catch { return fallback; }
}

async function evaluationObservations(repository:string):Promise<any[]> {
  const directory=path.join(projectRoot(),"config","eval-observations");
  try {
    const files=(await readdir(directory)).filter((file)=>file.endsWith(".json"));
    const observations=[];
    for (const file of files) {
      try {
        const value=JSON.parse(await readFile(path.join(directory,file),"utf8"));
        if (value.repository!==repository) continue;
        observations.push({file,caseId:value.caseId,date:value.date ?? value.ranAt,prompt:value.prompt,
          model:value.model,reasoningEffort:value.reasoningEffort,medians:value.medians ?? value.median,
          savingsPercent:value.savingsPercent ?? value.median?.saving,correctness:value.correctness});
      } catch { /* malformed observations do not break the operational UI */ }
    }
    return observations;
  } catch { return []; }
}

async function rawBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[]=[];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function body(req: http.IncomingMessage): Promise<any> {
  const text=await rawBody(req);
  return text ? JSON.parse(text) : {};
}

/** Sync runs already in flight, so the same commit is not indexed twice concurrently. */
const inFlight=new Map<string,Promise<unknown>>();

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
  const uiTools = new MemoryTools(memoryDb);
  const projections = new ProjectionCache(memoryDb);
  const freshnessCache = new FreshnessCache(memoryDb);
  const graphCache=new Map<string,{edges:ReturnType<MemoryStore["getRepositoryGraph"]>;routeFiles:Map<string,string>}>();
  const mcp = createMemoryMcpHttpHandler(memoryDb);
  const host = process.env.MEMORY_HOST ?? "127.0.0.1";
  const port = Number(process.env.MEMORY_PORT ?? 4317);

  const server = http.createServer(async (req,res) => {
    try {
      const url = new URL(req.url ?? "/",`http://${req.headers.host ?? "localhost"}`);

      // MCP over HTTP, for clients that connect by URL instead of spawning stdio.
      if (url.pathname === "/mcp") return void await mcp.node(req,res);

      if (req.method === "GET" && url.pathname === "/health") return json(res,200,{ok:true,vectorEnabled:memoryDb.vectorEnabled});

      // ---- browser UI ----
      if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/ui"))) {
        if (await serveUi(res,url.pathname)) return;
      }
      if (req.method === "GET" && url.pathname === "/api/ui/projects") {
        // Boot payload stays deliberately small. Quality and Git freshness are
        // computed only for the repository the user actually opens.
        const repositories=(store.listRepositories() as any[]).map((repository)=>({
          name:repository.name,framework:repository.framework,nextVersion:repository.next_version,
          reactVersion:repository.react_version,router:repository.router_type,
          lastIndexedSha:repository.last_indexed_sha,lastIndexedAt:repository.last_indexed_at,
        }));
        return json(res,200,{vectorEnabled:memoryDb.vectorEnabled,repositories});
      }
      const projectMatch=url.pathname.match(/^\/api\/ui\/project\/([^/]+)$/);
      if (req.method === "GET" && projectMatch) {
        const name=decodeURIComponent(projectMatch[1]!);
        const repository=store.getRepository(name) as any;
        if (!repository) return json(res,404,{error:"repository not found"});
        const [freshness,quality]=await Promise.all([
          freshnessCache.get(name),Promise.resolve(store.qualityReport(name) as any),
        ]);
        return json(res,200,{
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
      const askMatch=url.pathname.match(/^\/api\/ui\/ask\/([^/]+)$/);
      if (req.method === "POST" && askMatch) {
        const repository=decodeURIComponent(askMatch[1]!);
        const payload=await body(req);
        const question=String(payload.question ?? "").trim();
        if (question.length<3) return json(res,400,{error:"question must be at least 3 characters"});
        if (question.length>2_000) return json(res,400,{error:"question must be at most 2000 characters"});
        const started=Date.now();
        const pack=await uiTools.context(question,{repository,maxChars:Number(payload.maxChars) || undefined});
        return json(res,200,{question,durationMs:Date.now()-started,pack});
      }
      const uiRoutesMatch=url.pathname.match(/^\/api\/ui\/routes\/([^/]+)$/);
      if (req.method === "GET" && uiRoutesMatch) {
        const repository=decodeURIComponent(uiRoutesMatch[1]!);
        if (!store.getRepository(repository)) return json(res,404,{error:"repository not found"});
        const query=(url.searchParams.get("q") ?? "").trim().toLocaleLowerCase("tr-TR");
        const all=store.listRoutes(repository) as any[];
        const filtered=query ? all.filter((row)=>`${row.route} ${row.source_file} ${row.rendering_mode}`.toLocaleLowerCase("tr-TR").includes(query)) : all;
        const limit=Math.max(1,Math.min(250,Number(url.searchParams.get("limit") ?? 120)));
        return json(res,200,{repository,total:all.length,matched:filtered.length,routes:filtered.slice(0,limit).map((row)=>({
          route:row.route,type:row.route_type,sourceFile:row.source_file,rendering:row.rendering_mode,
          serverComponent:row.server_component==null ? null : Boolean(row.server_component),
          authRequired:row.auth_required==null ? null : Boolean(row.auth_required),
          dataSources:parseJson(row.data_sources_json,[]).length,
          backendDependencies:parseJson(row.backend_dependencies_json,[]).length,
          cache:parseJson(row.cache_behavior_json,[]),
        }))});
      }
      const uiRouteMatch=url.pathname.match(/^\/api\/ui\/route\/([^/]+)$/);
      if (req.method === "GET" && uiRouteMatch) {
        const route=url.searchParams.get("route");
        if (!route) return json(res,400,{error:"route is required"});
        try { return json(res,200,uiTools.route(decodeURIComponent(uiRouteMatch[1]!),route,{detail:"full",maxChars:24_000})); }
        catch (error) { return json(res,404,{error:(error as Error).message}); }
      }
      const economyMatch=url.pathname.match(/^\/api\/ui\/economy\/([^/]+)$/);
      if (req.method === "GET" && economyMatch) {
        const repository=decodeURIComponent(economyMatch[1]!);
        if (!store.getRepository(repository)) return json(res,404,{error:"repository not found"});
        const recent=telemetry.recent(repository,24).map((row:any)=>({
          ...row,queryShape:parseJson(row.query_shape_json,{}),gaps:parseJson(row.gaps_json,[]),
          query_shape_json:undefined,gaps_json:undefined,
        }));
        return json(res,200,{repository,report:telemetry.report(repository),recent,
          observations:await evaluationObservations(repository)});
      }
      const flowMatch=url.pathname.match(/^\/api\/ui\/flow\/([^/]+)$/);
      if (req.method === "GET" && flowMatch) {
        const repository=decodeURIComponent(flowMatch[1]!);
        const repo=store.getRepository(repository) as any;
        if (!repo) return json(res,404,{error:"repository not found"});
        const routes=store.listRoutes(repository) as any[];
        const graphKey=`${repository}:${repo.last_indexed_sha ?? "none"}`;
        if (!graphCache.has(graphKey)) {
          graphCache.set(graphKey,{edges:store.getRepositoryGraph(repository),
            routeFiles:new Map(routes.map((route)=>[route.route as string,route.source_file as string]))});
        }
        const { edges, routeFiles }=graphCache.get(graphKey)!;
        const seed=url.searchParams.get("seed")
          ?? edges.find((edge)=>edge.type==="submits-to")?.from
          ?? edges.find((edge)=>edge.from.includes("#"))?.from;
        if (!seed) return json(res,200,{seed:null,steps:[],endpoints:[],config:[],prunedSteps:0,entryPoints:[]});
        const trace=traceFlow(edges,seed,{routeEntries:routeEntriesFrom(edges,routeFiles),maxSteps:24});
        // Typed submit boundaries plus framework HTTP entry points; no project
        // handler-naming convention is assumed.
        const entryPoints=[...new Set(edges.filter((edge)=>edge.type==="submits-to"
          ||/#(?:POST|GET|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(edge.from)).map((edge)=>edge.from))].slice(0,12);
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
      // ---- CI / Git host webhook ----
      if (req.method === "POST" && url.pathname === "/webhook") {
        const text=await rawBody(req);
        try {
          authenticateWebhook({headers:req.headers,rawBody:text,remoteAddress:req.socket.remoteAddress});
          let payload:unknown;
          try { payload=text ? JSON.parse(text) : {}; }
          catch { throw new WebhookError("Body is not valid JSON",400); }

          const intent=await parseWebhook(payload,url.searchParams);
          const config=await getRepositoryConfig(intent.repository);
          const key=`${intent.repository}@${intent.commit}`;
          const started=inFlight.get(key)
            ?? enqueue(()=>incrementalSync(config,memoryDb,{expectedCommit:intent.commit}))
              .finally(()=>inFlight.delete(key));
          inFlight.set(key,started);

          // Indexing can take minutes; a Git host will time out long before that.
          // `?wait=1` is for a pipeline that wants its build to fail on a bad index.
          if (url.searchParams.get("wait")==="1") {
            return json(res,200,{accepted:true,...intent,result:await started});
          }
          started.catch((error)=>console.error(`[memory] webhook sync failed for ${key}: ${(error as Error).message}`));
          return json(res,202,{accepted:true,...intent,mode:"queued",
            note:"Indexing runs in the background. Add ?wait=1 to receive the result instead."});
        } catch (error) {
          if (error instanceof WebhookError) {
            // 202 is how a deliberate skip is reported: the delivery was fine, the branch was not ours.
            return json(res,error.status,{accepted:false,reason:error.message});
          }
          return json(res,500,{accepted:false,reason:(error as Error).message});
        }
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
  const stopScheduler=startRegistrySupervisor(memoryDb,enqueue);
  server.on("close",()=>{ stopScheduler(); void mcp.close(); });
  server.listen(port,host,()=>{
    console.log(`[memory] server listening on http://${host}:${port}`);
    console.log(`[memory] browser readout http://${host}:${port}/  ·  MCP endpoint http://${host}:${port}/mcp`);
    console.log(`[memory] webhook http://${host}:${port}/webhook${process.env.MEMORY_WEBHOOK_SECRET ? "" : "  (loopback only until MEMORY_WEBHOOK_SECRET is set)"}`);
  });
  return server;
}
