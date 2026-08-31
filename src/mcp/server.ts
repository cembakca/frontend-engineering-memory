import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as z from "zod/v4";
import { MemoryDatabase } from "../memory/database.js";
import { MemoryTools } from "./tools.js";

const memoryTypes=[
  "repository_profile","rendering","api_dependency","data_fetching","cache","authentication","middleware",
  "state_management","design_system","shared_package","seo","analytics","error_handling","configuration","build",
  "dependency","security","performance_observation","business_capability","business_rule","technical_debt",
] as const;

function output(value:any) {
  const structured=value && typeof value==="object" && !Array.isArray(value) ? value : {value};
  return {content:[{type:"text" as const,text:JSON.stringify(structured)}],structuredContent:structured};
}

function failure(error:unknown) {
  return {content:[{type:"text" as const,text:JSON.stringify({error:(error as Error).message})}],isError:true};
}

function readOnly() { return {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}; }

export function createMemoryMcpServer(memoryDb=new MemoryDatabase()):McpServer {
  const tools=new MemoryTools(memoryDb);
  const server=new McpServer(
    {name:"frontend-engineering-memory",version:"0.2.0"},
    {
      capabilities:{tools:{}},
      instructions:"Use this server before scanning source code. Prefer exact repository/route/dependency tools, then memory_search with limit 5. Treat returned facts as a small context pack; open only listed evidence files when more detail is needed. Never request or load the whole memory database. Check lastIndexedSha when freshness matters. All tools are read-only.",
    },
  );

  server.registerTool("memory_list_repositories",{
    title:"List frontend memory repositories",description:"List indexed repositories and their last indexed Git SHA. Use first when repository identity or freshness is unknown.",annotations:readOnly(),
  },async()=>output(tools.repositories()));

  server.registerTool("memory_get_repository",{
    title:"Get repository profile",description:"Return the exact structured profile and last indexed SHA for one repository.",inputSchema:z.object({repository:z.string().min(1)}),annotations:readOnly(),
  },async({repository})=>{ try { return output(tools.repository(repository)); } catch(error) { return failure(error); } });

  server.registerTool("memory_list_routes",{
    title:"List active routes",description:"Return a compact structured active route inventory. Prefer this over semantic search for route lists.",
    inputSchema:z.object({repository:z.string().min(1),limit:z.number().int().min(1).max(100).default(50)}),annotations:readOnly(),
  },async({repository,limit})=>output(tools.routes(repository,limit)));

  server.registerTool("memory_get_route",{
    title:"Get one route",description:"Return one exact route with rendering, client boundaries, cache, middleware, SEO, evidence and dependency edges.",
    inputSchema:z.object({repository:z.string().min(1),route:z.string().startsWith("/")}),annotations:readOnly(),
  },async({repository,route})=>{ try { return output(tools.route(repository,route)); } catch(error) { return failure(error); } });

  server.registerTool("memory_dependencies",{
    title:"Get dependencies",description:"Return compact npm, internal-package, HTTP and configuration dependencies; optionally restrict them to one route.",
    inputSchema:z.object({repository:z.string().min(1),route:z.string().startsWith("/").optional(),type:z.enum(["npm","internal-package","http","config"]).optional(),limit:z.number().int().min(1).max(100).default(30)}),annotations:readOnly(),
  },async({repository,route,type,limit})=>output(tools.dependencies(repository,{route,type,limit})));

  server.registerTool("memory_search",{
    title:"Search technical memory",description:"Return a token-bounded SQL/FTS/vector context pack with source evidence. Default to 5 results; increase only when recall is insufficient.",
    inputSchema:z.object({query:z.string().min(2),repository:z.string().min(1).optional(),types:z.array(z.enum(memoryTypes)).max(8).optional(),limit:z.number().int().min(1).max(10).default(5),maxChars:z.number().int().min(1000).max(24000).default(8000)}),annotations:readOnly(),
  },async({query,repository,types,limit,maxChars})=>{ try { return output(await tools.search(query,{repository,types,limit,maxChars})); } catch(error) { return failure(error); } });

  server.registerTool("memory_changed_since",{
    title:"Get memory changes after Git SHA",description:"Return CREATE and DEACTIVATE memory events after a previously indexed Git SHA. Use for merge/change summaries.",
    inputSchema:z.object({repository:z.string().min(1),since:z.string().regex(/^[0-9a-f]{40}$/i),limit:z.number().int().min(1).max(200).default(50),maxChars:z.number().int().min(1000).max(24000).default(10000)}),annotations:readOnly(),
  },async({repository,since,limit,maxChars})=>output(tools.changes(repository,since,limit,maxChars)));

  server.registerTool("memory_explain",{
    title:"Build grounded explanation context",description:"Build a token-bounded evidence context pack for an engineering question. The calling model should synthesize the explanation and only open evidence files if necessary.",
    inputSchema:z.object({question:z.string().min(2),repository:z.string().min(1).optional(),limit:z.number().int().min(1).max(10).default(5),maxChars:z.number().int().min(1000).max(24000).default(8000)}),annotations:readOnly(),
  },async({question,repository,limit,maxChars})=>{ try { return output(await tools.explain(question,{repository,limit,maxChars})); } catch(error) { return failure(error); } });

  server.registerTool("memory_quality",{
    title:"Get memory quality metrics",description:"Return evidence, commit, symbol, line and vector coverage for one repository or the complete registry.",
    inputSchema:z.object({repository:z.string().min(1).optional()}),annotations:readOnly(),
  },async({repository})=>output(tools.quality(repository)));

  return server;
}

export function serveMemoryMcp():void {
  // stdout belongs exclusively to MCP JSON-RPC. Redirect accidental application logs.
  console.log=(...args:unknown[])=>console.error(...args);
  void serveStdio(()=>createMemoryMcpServer(),{onerror:(error)=>console.error(`[memory-mcp] ${error.message}`)});
}

if (process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) serveMemoryMcp();
