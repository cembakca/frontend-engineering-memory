import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { MemoryDatabase } from "../src/memory/database.js";
import { createMemoryMcpServer } from "../src/mcp/server.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

test("exposes bounded read-only memory tools over MCP",async()=>{
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-mcp-"));
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  const server=createMemoryMcpServer(memoryDb);
  const client=new Client({name:"test-client",version:"1.0.0"});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  try {
    memoryDb.db.prepare("INSERT INTO repositories(name,path,next_version,router_type,last_indexed_sha) VALUES(?,?,?,?,?)").run("fixture","/fixture","16.0.0","app","a".repeat(40));
    const memory=memoryDb.db.prepare("INSERT INTO memories(repository_id,memory_type,subject,content,confidence,created_sha,updated_sha) VALUES(1,'configuration','GATEWAY_URL','GATEWAY_URL configures the backend gateway.','verified',?,?)").run("a".repeat(40),"a".repeat(40));
    const memoryId=Number(memory.lastInsertRowid);
    memoryDb.db.prepare("INSERT INTO memory_evidence(memory_id,file_path,start_line,end_line,commit_sha) VALUES(?,?,?,?,?)").run(memoryId,"src/config.ts",3,3,"a".repeat(40));
    memoryDb.db.prepare("INSERT INTO memory_fts(memory_id,repository_id,memory_type,subject,content) VALUES(?,?,?,?,?)").run(memoryId,1,"configuration","GATEWAY_URL","GATEWAY_URL configures the backend gateway.");
    await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
    const listed=await client.listTools();
    assert.ok(listed.tools.some((tool)=>tool.name==="memory_search"));
    assert.ok(listed.tools.some((tool)=>tool.name==="memory_get_route"));
    assert.ok(listed.tools.every((tool)=>tool.annotations?.readOnlyHint===true));
    const result=await client.callTool({name:"memory_get_repository",arguments:{repository:"fixture"}});
    assert.equal((result.structuredContent as any).nextVersion,"16.0.0");
    const quality=await client.callTool({name:"memory_quality",arguments:{repository:"fixture"}});
    assert.equal((quality.structuredContent as any).repository,"fixture");
    const search=await client.callTool({name:"memory_search",arguments:{repository:"fixture",query:"GATEWAY_URL configuration",limit:5,maxChars:1200}});
    assert.equal((search.structuredContent as any).items[0].subject,"GATEWAY_URL");
    assert.ok((search.structuredContent as any).estimatedTokens<400);
  } finally {
    await client.close();
    await server.close();
    memoryDb.close();
    await rm(root,{recursive:true,force:true});
  }
});
