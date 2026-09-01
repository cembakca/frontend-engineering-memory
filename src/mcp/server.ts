import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as z from "zod/v4";
import { MemoryDatabase } from "../memory/database.js";
import { MemoryTools } from "./tools.js";

const memoryTypes=[
  "repository_profile","rendering","api_dependency","data_fetching","cache","cache_invalidation","server_function","authentication","authorization","middleware",
  "state_management","design_system","shared_package","seo","analytics","analytics_event","error_handling","module_contract","schema_contract","next_config","special_file","configuration","build",
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

export const MCP_INSTRUCTIONS="For every route, route-source, page-location, or rendering question, call memory_route before source search; its route input accepts either a known /path or the user's natural page/product wording. A fresh, non-truncated summary containing the requested route, sourceFile, rendering, and renderingEvidence is sufficient: answer directly without reopening source. Use memory_repository for repository inventory and cross-repository package links. Request memory_route detail=runtime, dependencies, or full only when the question needs it. Turkish/Unicode aliases are normalized. Use memory_context once for other engineering questions; follow answerContract and open only sourceFallback files when uncertainty remains. Historical/rationale rules still apply. All tools are read-only.";

export function createMemoryMcpServer(memoryDb=new MemoryDatabase()):McpServer {
  const tools=new MemoryTools(memoryDb);
  const server=new McpServer(
    {name:"frontend-engineering-memory",version:"0.2.0"},
    {
      capabilities:{tools:{}},
      instructions:MCP_INSTRUCTIONS,
    },
  );

  server.registerTool("memory_repository",{
    title:"List or get memory repositories",description:"Without repository, list indexed repositories, SHAs, and cross-repository package links. With repository, return its exact profile, dependencies on other indexed repositories, consumers, and freshness metadata.",
    inputSchema:z.object({repository:z.string().min(1).optional()}),annotations:readOnly(),
  },async({repository})=>{ try { return output(repository ? tools.repository(repository) : tools.repositories()); } catch(error) { return failure(error); } });

  server.registerTool("memory_route",{
    title:"List, locate or get routes",description:"Repository is optional for fleet-wide discovery. Route accepts either a known /path or a natural product/page name resolved through repository aliases. Exact lookup defaults to a bounded route/source/rendering summary.",
    inputSchema:z.object({repository:z.string().min(1).optional(),route:z.string().min(2).optional(),limit:z.number().int().min(1).max(100).default(50),
      detail:z.enum(["summary","runtime","dependencies","full"]).default("summary"),maxChars:z.number().int().min(500).max(24000).default(8000)}),annotations:readOnly(),
  },async({repository,route,limit,detail,maxChars})=>{ try { return output(route ? tools.route(repository,route,{detail,maxChars}) : tools.routes(repository,limit,maxChars)); } catch(error) { return failure(error); } });

  server.registerTool("memory_context",{
    title:"Compile task context",description:"Call once before source search for flow, impact, debug, implementation, verification, change review, approved decisions, an indexed SHA, or behavior diff. Returns an evidence-linked bounded pack and answer contract; omit maxChars to let the engine choose its budget.",
    inputSchema:z.object({question:z.string().min(2),repository:z.string().min(1),types:z.array(z.enum(memoryTypes)).max(8).optional(),maxChars:z.number().int().min(1000).max(24000).optional(),since:z.string().regex(/^[0-9a-f]{40}$/i).optional(),atSha:z.string().regex(/^[0-9a-f]{40}$/i).optional(),compareToSha:z.string().regex(/^[0-9a-f]{40}$/i).optional()}),annotations:readOnly(),
  },async({question,repository,types,maxChars,since,atSha,compareToSha})=>{ try { return output(await tools.context(question,{repository,types,maxChars,since,atSha,compareToSha})); } catch(error) { return failure(error); } });

  return server;
}

/**
 * The same tool surface over HTTP, for clients that connect by URL (Cursor and
 * friends) rather than by spawning a process. One factory backs both entries, so
 * a stdio client and an HTTP client always see identical tools.
 *
 * Stateless by construction: each request gets a fresh server over the shared
 * database handle, which keeps the endpoint safe to expose from the long-running
 * HTTP server without holding per-session state.
 */
export function createMemoryMcpHttpHandler(memoryDb:MemoryDatabase) {
  const handler=createMcpHandler(()=>createMemoryMcpServer(memoryDb));
  return {
    node:toNodeHandler(handler,{onerror:(error:unknown)=>console.error(`[memory-mcp/http] ${(error as Error).message}`)}),
    close:()=>handler.close(),
  };
}

export function serveMemoryMcp():void {
  // stdout belongs exclusively to MCP JSON-RPC. Redirect accidental application logs.
  console.log=(...args:unknown[])=>console.error(...args);
  void serveStdio(()=>createMemoryMcpServer(),{onerror:(error)=>console.error(`[memory-mcp] ${error.message}`)});
}

if (process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) serveMemoryMcp();
