import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { startServer } from "../src/server.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

test("HTTP sync requires a full expected commit SHA",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  process.env.MEMORY_HOST="127.0.0.1";
  process.env.MEMORY_PORT="0";
  const dbRoot=await mkdtemp(path.join(os.tmpdir(),"fem-server-db-"));
  const memoryDb=new MemoryDatabase(path.join(dbRoot,"memory.sqlite"));
  const server=startServer(memoryDb);
  try {
    if (!server.listening) await once(server,"listening");
    const address=server.address();
    assert.ok(address && typeof address === "object");
    const response=await fetch(`http://127.0.0.1:${address.port}/sync`,{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({repository:"fixture"}),
    });
    assert.equal(response.status,400);
    assert.deepEqual(await response.json(),{error:"commit must be a full 40-character Git SHA"});
  } finally {
    await new Promise<void>((resolve,reject)=>server.close((error)=>error ? reject(error) : resolve()));
    memoryDb.close();
    await rm(dbRoot,{recursive:true,force:true});
  }
});

test("UI boot stays lightweight and loads only the selected repository detail and stored graph",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  process.env.MEMORY_HOST="127.0.0.1";
  process.env.MEMORY_PORT="0";
  const dbRoot=await mkdtemp(path.join(os.tmpdir(),"fem-ui-db-"));
  const memoryDb=new MemoryDatabase(path.join(dbRoot,"memory.sqlite"));
  const sha="a".repeat(40);
  memoryDb.db.prepare("INSERT INTO repositories(name,path,framework,router_type,last_indexed_sha) VALUES(?,?,?,?,?)")
    .run("fixture","/unavailable/fixture","Next.js","app",sha);
  memoryDb.db.prepare("INSERT INTO routes(repository_id,route,route_type,router_type,source_file,rendering_mode,last_seen_sha) VALUES(1,'/','page','app','src/app/page.tsx','rsc',?)")
    .run(sha);
  const graph=[{type:"calls",from:"src/app/page.tsx#Page",fromKind:"component",to:"src/data.ts#load",toKind:"symbol",
    filePath:"src/app/page.tsx",symbol:"Page",startLine:4,confidence:"observed"}];
  memoryDb.db.prepare("INSERT INTO repository_snapshots(repository_id,sha,profile_json,routes_json,dependencies_json,memories_json,graph_json) VALUES(1,?,'{}','[]','[]','[]',?)")
    .run(sha,JSON.stringify(graph));
  const server=startServer(memoryDb);
  try {
    if (!server.listening) await once(server,"listening");
    const address=server.address();
    assert.ok(address && typeof address === "object");
    const origin=`http://127.0.0.1:${address.port}`;

    const projects=await (await fetch(`${origin}/api/ui/projects`)).json() as any;
    const summary=projects.repositories.find((item:any)=>item.name==="fixture");
    assert.equal(summary.framework,"Next.js");
    assert.equal("facts" in summary,false,"boot must not run repository quality aggregation");
    assert.equal("freshness" in summary,false,"boot must not run Git freshness checks");

    const detail=await (await fetch(`${origin}/api/ui/project/fixture`)).json() as any;
    assert.equal(detail.name,"fixture");
    assert.equal(detail.routes,1);
    assert.equal(detail.facts,0);

    const flow=await (await fetch(`${origin}/api/ui/flow/fixture?seed=${encodeURIComponent("src/app/page.tsx#Page")}`)).json() as any;
    assert.equal(flow.totalEdges,1);
    assert.equal(flow.steps[0].to,"src/data.ts#load");

    const routes=await (await fetch(`${origin}/api/ui/routes/fixture?q=page`)).json() as any;
    assert.equal(routes.total,1);
    assert.equal(routes.routes[0].sourceFile,"src/app/page.tsx");
    const route=await (await fetch(`${origin}/api/ui/route/fixture?route=${encodeURIComponent("/")}`)).json() as any;
    assert.equal(route.route,"/");
    assert.equal(route.sourceFile,"src/app/page.tsx");

    const asked=await (await fetch(`${origin}/api/ui/ask/fixture`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({question:"Ana route hangi source dosyasındadır?"}),
    })).json() as any;
    assert.equal(asked.pack.repository,"fixture");
    assert.ok(asked.pack.telemetryEventId);
    const economy=await (await fetch(`${origin}/api/ui/economy/fixture`)).json() as any;
    assert.equal(economy.report.events,1);
    assert.equal(economy.recent[0].tool,"memory_context");
  } finally {
    await new Promise<void>((resolve,reject)=>server.close((error)=>error ? reject(error) : resolve()));
    memoryDb.close();
    await rm(dbRoot,{recursive:true,force:true});
  }
});
