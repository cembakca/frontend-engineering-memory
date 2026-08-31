import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { startServer } from "../src/server.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

/** One JSON-RPC exchange against the HTTP endpoint, accepting either response framing. */
async function rpc(base:string,method:string,params:unknown,id=1):Promise<any> {
  const response=await fetch(`${base}/mcp`,{
    method:"POST",
    headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},
    body:JSON.stringify({jsonrpc:"2.0",id,method,params}),
  });
  assert.ok(response.ok,`${method} returned ${response.status}`);
  const text=await response.text();
  // Streamable HTTP may answer as SSE; the JSON-RPC envelope is the same either way.
  const line=text.split(/\r?\n/).find((item)=>item.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : text);
}

async function withServer(run:(base:string)=>Promise<void>):Promise<void> {
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-mcp-http-"));
  const previousPort=process.env.MEMORY_PORT;
  process.env.MEMORY_PORT="0";
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  memoryDb.db.prepare("INSERT INTO repositories(name,path,next_version,router_type,last_indexed_sha) VALUES(?,?,?,?,?)")
    .run("fixture","/fixture","16.3.0","app","a".repeat(40));
  const memory=memoryDb.db.prepare(
    "INSERT INTO memories(repository_id,memory_type,subject,content,confidence,created_sha,updated_sha) VALUES(1,'configuration','GATEWAY_URL',?,'verified',?,?)",
  ).run("Configuration key GATEWAY_URL is read in src/lib/gateway.ts.","a".repeat(40),"a".repeat(40));
  const memoryId=Number(memory.lastInsertRowid);
  memoryDb.db.prepare("INSERT INTO memory_evidence(memory_id,file_path,start_line,end_line,commit_sha) VALUES(?,?,?,?,?)")
    .run(memoryId,"src/lib/gateway.ts",9,9,"a".repeat(40));
  memoryDb.db.prepare("INSERT INTO memory_fts(memory_id,repository_id,memory_type,subject,content) VALUES(?,1,'configuration','GATEWAY_URL',?)")
    .run(memoryId,"Configuration key GATEWAY_URL is read in src/lib/gateway.ts.");

  const server=startServer(memoryDb);
  await new Promise<void>((resolve)=>server.once("listening",resolve));
  const { port }=server.address() as AddressInfo;
  try { await run(`http://127.0.0.1:${port}`); }
  finally {
    await new Promise<void>((resolve)=>server.close(()=>resolve()));
    memoryDb.close();
    if (previousPort===undefined) delete process.env.MEMORY_PORT; else process.env.MEMORY_PORT=previousPort;
    await rm(root,{recursive:true,force:true});
  }
}

test("serves the MCP handshake over HTTP",async()=>{
  await withServer(async(base)=>{
    const result=await rpc(base,"initialize",{protocolVersion:"2025-06-18",capabilities:{},
      clientInfo:{name:"test",version:"1.0"}});
    assert.equal(result.result.serverInfo.name,"frontend-engineering-memory");
    assert.ok(result.result.capabilities.tools,"tools capability must be advertised");
  });
});

test("exposes the same three tools an stdio client sees",async()=>{
  await withServer(async(base)=>{
    const result=await rpc(base,"tools/list",{},2);
    const names=result.result.tools.map((tool:any)=>tool.name).sort();
    assert.deepEqual(names,["memory_context","memory_repository","memory_route"]);
    assert.ok(result.result.tools.every((tool:any)=>tool.annotations?.readOnlyHint===true),
      "an HTTP client must not be handed a writable surface");
  });
});

test("answers a tool call with the real index behind it",async()=>{
  await withServer(async(base)=>{
    const result=await rpc(base,"tools/call",{name:"memory_repository",arguments:{repository:"fixture"}},3);
    assert.equal(result.result.structuredContent.name,"fixture");
    assert.equal(result.result.structuredContent.nextVersion,"16.3.0");
  });
});

test("keeps the browser readout and the MCP endpoint on the same port",async()=>{
  await withServer(async(base)=>{
    const ui=await fetch(`${base}/`);
    assert.equal(ui.status,200);
    assert.ok((ui.headers.get("content-type") ?? "").includes("text/html"));
    const projects=await (await fetch(`${base}/api/ui/projects`)).json();
    assert.equal(projects.repositories[0].name,"fixture");
  });
});
