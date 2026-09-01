import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "../config.js";
import { MemoryDatabase } from "../memory/database.js";
import { createMemoryMcpServer, MCP_INSTRUCTIONS } from "../mcp/server.js";
import { readJson, readTextIfSmall } from "../utils/fs.js";

/** Same divisor as the context packer and the evaluation harness. */
const CHARS_PER_TOKEN=3.5;

function tokensFor(chars:number):number { return Math.ceil(chars/CHARS_PER_TOKEN); }

/**
 * What every session pays before a single question is asked.
 *
 * The tool schemas are serialized exactly as a client receives them from
 * `tools/list`. The MCP client package is a dev dependency, so a production
 * install reports this line as unavailable rather than failing.
 */
async function fixedSessionCost(policyFile?:string):Promise<any> {
  const instructions=MCP_INSTRUCTIONS;

  let toolDefinitions:any={available:false,reason:"@modelcontextprotocol/client is not installed (dev dependency)"};
  let root:string|null=null;
  try {
    const { Client, InMemoryTransport }=await import("@modelcontextprotocol/client");
    root=await mkdtemp(path.join(os.tmpdir(),"fem-economy-"));
    const previous=process.env.MEMORY_EMBEDDINGS_ENABLED;
    process.env.MEMORY_EMBEDDINGS_ENABLED="0";
    const memoryDb=new MemoryDatabase(path.join(root,"probe.sqlite"));
    const server=createMemoryMcpServer(memoryDb);
    const client=new Client({name:"context-economy",version:"0.2.0"});
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
      const listed=await client.listTools();
      const perTool=listed.tools
        .map((tool:any)=>{
          const chars=JSON.stringify({name:tool.name,title:tool.title,description:tool.description,inputSchema:tool.inputSchema,annotations:tool.annotations}).length;
          return {tool:tool.name,chars,tokens:tokensFor(chars)};
        })
        .sort((a:any,b:any)=>b.chars-a.chars);
      const chars=perTool.reduce((sum:number,item:any)=>sum+item.chars,0);
      const nameOnlyChars=listed.tools.reduce((sum:number,tool:any)=>sum+tool.name.length+2,0);
      toolDefinitions={
        available:true,
        tools:perTool.length,
        chars,
        tokens:tokensFor(chars),
        perTool,
        // Clients that defer schemas (Claude Code tool search) load names first
        // and fetch a schema only when a tool is actually needed.
        deferredNameOnly:{chars:nameOnlyChars,tokens:tokensFor(nameOnlyChars)},
      };
    } finally {
      await client.close();
      await server.close();
      memoryDb.close();
      if (previous===undefined) delete process.env.MEMORY_EMBEDDINGS_ENABLED; else process.env.MEMORY_EMBEDDINGS_ENABLED=previous;
    }
  } catch (error) {
    toolDefinitions={available:false,reason:(error as Error).message};
  } finally {
    if (root) await rm(root,{recursive:true,force:true});
  }

  let repositoryPolicy:any={available:false,reason:"no policy file given"};
  if (policyFile) {
    const text=await readTextIfSmall(path.resolve(policyFile));
    const block=text?.match(/<!-- BEGIN:frontend-engineering-memory -->[\s\S]*?<!-- END:frontend-engineering-memory -->/)?.[0];
    repositoryPolicy=block
      ? {available:true,file:path.resolve(policyFile),chars:block.length,tokens:tokensFor(block.length)}
      : {available:false,reason:`memory policy block not found in ${policyFile}`};
  }

  const known=[toolDefinitions.available ? toolDefinitions.tokens : 0,tokensFor(instructions.length),repositoryPolicy.available ? repositoryPolicy.tokens : 0];
  return {
    toolDefinitions,
    serverInstructions:{chars:instructions.length,tokens:tokensFor(instructions.length)},
    repositoryPolicy,
    totalTokens:known.reduce((sum,value)=>sum+value,0),
    complete:toolDefinitions.available && repositoryPolicy.available,
  };
}

function median(values:number[]):number|null {
  if (!values.length) return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.floor(sorted.length/2)]!;
}

/**
 * The variable ledger, read back from a context-eval run.
 *
 * Two scenarios are reported because payload size alone does not decide the
 * economics. A pack that is cheap but wrong does not replace the source read;
 * the agent pays for both.
 */
function variableCost(run:any):any {
  const perCase=run.cases.map((item:any)=>{
    const clean=item.diagnosis.primaryMissClass===null;
    return {
      caseId:item.caseId,
      clean,
      // A question the source cannot answer has no source read to compare against,
      // so "the engine costs more than reading source" is not a meaningful claim.
      comparable:item.policy!=="abstain",
      engineTokens:item.engine.tokens,
      baselineTokens:item.baseline.tokens,
      baselineSourceTokens:item.baseline.sourceTokens ?? item.baseline.tokens,
      baselineDiscoveryTokens:tokensFor(Number(item.baseline.discoveryChars ?? 0)),
      baselineMeasurement:item.baseline.measurement ?? "legacy-combined-estimate",
      nominalSaving:item.baseline.tokens-item.engine.tokens,
      // A failed pack does not remove the source read, so the engine cost is added to it.
      effectiveSaving:clean ? item.baseline.tokens-item.engine.tokens : -item.engine.tokens,
    };
  });
  const nominal=perCase.map((item:any)=>item.nominalSaving);
  const effective=perCase.map((item:any)=>item.effectiveSaving);
  const comparable=perCase.filter((item:any)=>item.comparable);
  return {
    cases:perCase.length,
    comparableCases:comparable.length,
    cleanCases:perCase.filter((item:any)=>item.clean).length,
    nominal:{
      total:nominal.reduce((a:number,b:number)=>a+b,0),
      median:median(nominal),
      negativeCases:comparable.filter((item:any)=>item.nominalSaving<0).map((item:any)=>item.caseId),
      /** Abstention cases, reported separately because they have no source baseline. */
      abstentionCases:perCase.filter((item:any)=>!item.comparable).map((item:any)=>item.caseId),
    },
    effective:{total:effective.reduce((a:number,b:number)=>a+b,0),median:median(effective)},
    perCase,
  };
}

export async function runContextEconomy(options:{run?:string;policyFile?:string}={}):Promise<any> {
  const runFile=path.resolve(options.run ?? path.join(projectRoot(),"eval-results/rce-002-final.json"));
  const run=await readJson<any>(runFile);
  if (!run?.cases?.length) throw new Error(`Context evaluation run not found or empty: ${runFile}`);

  const fixed=await fixedSessionCost(options.policyFile);
  const variable=variableCost(run);
  const nominalBreakEven=variable.nominal.median && variable.nominal.median>0
    ? Number((fixed.totalTokens/variable.nominal.median).toFixed(2))
    : null;

  return {
    ranAt:new Date().toISOString(),
    sourceRun:runFile,
    targetSha:run.targetSha,
    charsPerToken:CHARS_PER_TOKEN,
    fixedSessionCost:fixed,
    variableCost:variable,
    breakEven:{
      nominalQuestionsPerSession:nominalBreakEven,
      note:"Questions a session must ask before the fixed cost is repaid, assuming the pack fully replaces the source read. Not reached when the pack is wrong or empty.",
    },
    // Only the client knows these; the engine must never guess them.
    clientReported:{
      totalContextTokens:null,
      systemPromptTokens:null,
      toolDefinitionTokens:null,
      mcpResultTokens:null,
      sourceToolResultTokens:null,
      cacheReadTokens:null,
      cacheWriteTokens:null,
      outputTokens:null,
      note:"Fill from the client context breakdown. Keep total context, fixed tool definitions, MCP results, source results, cache reads/writes and output separate; the harness measures payload, not billed context.",
    },
  };
}
