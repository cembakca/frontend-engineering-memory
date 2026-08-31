import http from "node:http";
import { URL } from "node:url";
import { getRepositoryConfig } from "./config.js";
import { MemoryDatabase } from "./memory/database.js";
import { MemoryStore } from "./memory/store.js";
import { hybridSearch } from "./retrieval/search.js";
import { fullIndex, incrementalSync } from "./sync/sync.js";
import { startReconciliationScheduler } from "./sync/reconcile.js";

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

let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(job, job);
  writeQueue = next.then(() => undefined, () => undefined);
  return next;
}

export function startServer(memoryDb = new MemoryDatabase()): http.Server {
  const store = new MemoryStore(memoryDb);
  const host = process.env.MEMORY_HOST ?? "127.0.0.1";
  const port = Number(process.env.MEMORY_PORT ?? 4317);

  const server = http.createServer(async (req,res) => {
    try {
      const url = new URL(req.url ?? "/",`http://${req.headers.host ?? "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") return json(res,200,{ok:true,vectorEnabled:memoryDb.vectorEnabled});
      if (req.method === "GET" && url.pathname === "/repositories") return json(res,200,store.listRepositories());
      if (req.method === "GET" && url.pathname === "/quality") return json(res,200,store.qualityReport(url.searchParams.get("repo") ?? undefined));
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
