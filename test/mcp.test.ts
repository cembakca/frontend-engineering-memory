import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    await mkdir(path.join(root,"src/app"),{recursive:true});
    await mkdir(path.join(root,"src/components"),{recursive:true});
    await writeFile(path.join(root,"src/app/page.tsx"),'import { Widget } from "../components/widget";\nexport default function Page(){ return <Widget/>; }\n');
    await writeFile(path.join(root,"src/components/widget.tsx"),'export async function Widget(){ await fetch("https://api.example.test/items"); return <button>Go</button>; }\n');
    memoryDb.db.prepare("INSERT INTO repositories(name,path,next_version,router_type,last_indexed_sha) VALUES(?,?,?,?,?)").run("fixture",root,"16.0.0","app","a".repeat(40));
    const memory=memoryDb.db.prepare("INSERT INTO memories(repository_id,memory_type,subject,content,confidence,created_sha,updated_sha) VALUES(1,'configuration','GATEWAY_URL','GATEWAY_URL configures the backend gateway.','verified',?,?)").run("a".repeat(40),"a".repeat(40));
    const memoryId=Number(memory.lastInsertRowid);
    memoryDb.db.prepare("INSERT INTO memory_evidence(memory_id,file_path,start_line,end_line,commit_sha) VALUES(?,?,?,?,?)").run(memoryId,"src/config.ts",3,3,"a".repeat(40));
    memoryDb.db.prepare("INSERT INTO memory_fts(memory_id,repository_id,memory_type,subject,content) VALUES(?,?,?,?,?)").run(memoryId,1,"configuration","GATEWAY_URL","GATEWAY_URL configures the backend gateway.");
    await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
    const listed=await client.listTools();
    assert.deepEqual(listed.tools.map((tool)=>tool.name).sort(),["memory_context","memory_repository","memory_route"]);
    assert.ok(listed.tools.every((tool)=>tool.annotations?.readOnlyHint===true));
    const result=await client.callTool({name:"memory_repository",arguments:{repository:"fixture"}});
    assert.equal((result.structuredContent as any).nextVersion,"16.0.0");
    const search=await client.callTool({name:"memory_context",arguments:{repository:"fixture",question:"GATEWAY_URL configuration",maxChars:1500}});
    assert.equal((search.structuredContent as any).items[0].subject,"GATEWAY_URL");
    assert.ok((search.structuredContent as any).estimatedTokens<400);
    assert.deepEqual((search.structuredContent as any).answerContract.facts,["items[claimKind=fact]"]);
    assert.ok(JSON.stringify(search.structuredContent).length<=1500,`lookup pack used ${JSON.stringify(search.structuredContent).length} chars`);
    assert.equal((search.structuredContent as any).freshness.state,"unknown","every pack declares its freshness (RCE-026)");
    const flow=await client.callTool({name:"memory_context",arguments:{repository:"fixture",question:"Explain the flow from src/app/page.tsx",maxChars:2000}});
    assert.equal((flow.structuredContent as any).kind,"flow");
    assert.ok((flow.structuredContent as any).steps.some((step:any)=>step.relation==="renders"));
    assert.ok((flow.structuredContent as any).answerContract.derivedRelations.includes("steps"));
  } finally {
    await client.close();
    await server.close();
    memoryDb.close();
    await rm(root,{recursive:true,force:true});
  }
});
