import type { MemoryDatabase } from "../memory/database.js";
import { MemoryStore } from "../memory/store.js";
import type { MemoryType } from "../types.js";
import { hybridSearch } from "./search.js";

function truncate(value:string,max:number):string {
  return value.length<=max ? value : `${value.slice(0,Math.max(0,max-1))}…`;
}

function estimateTokens(value:unknown):number {
  return Math.ceil(JSON.stringify(value).length/3.5);
}

export async function buildAgentContext(
  memoryDb:MemoryDatabase,
  query:string,
  options:{repository?:string;memoryTypes?:MemoryType[];limit?:number;maxChars?:number}={},
):Promise<any> {
  const limit=Math.max(1,Math.min(10,options.limit ?? 5));
  const maxChars=Math.max(1000,Math.min(24000,options.maxChars ?? 8000));
  const store=new MemoryStore(memoryDb);
  const results=await hybridSearch(memoryDb,query,{repo:options.repository,memoryTypes:options.memoryTypes,limit:limit*2});
  const evidence=store.memoryEvidence(results.filter((item)=>item.id>0).map((item)=>item.id));
  const items:any[]=[];
  for (const result of results) {
    const sourceEvidence=evidence.get(result.id) ?? [];
    const item={
      id:result.id,
      repository:result.repository,
      type:result.type,
      subject:result.subject,
      fact:truncate(result.content,1200),
      sourceFile:result.sourceFile,
      commitSha:result.commitSha,
      channels:result.channels,
      evidence:(sourceEvidence.length ? sourceEvidence.slice(0,4).map((row:any)=>({
        file:row.file_path,symbol:row.symbol,startLine:row.start_line,endLine:row.end_line,commitSha:row.commit_sha,
      })) : result.sourceFile ? [{file:result.sourceFile,symbol:null,startLine:null,endLine:null,commitSha:result.commitSha}] : []),
    };
    const candidate={query,items:[...items,item]};
    if (JSON.stringify(candidate).length>maxChars && items.length) break;
    items.push(item);
    if (items.length>=limit) break;
  }
  const pack={
    query,
    repository:options.repository ?? null,
    items,
    guidance:items.length
      ? "Answer from these facts first. Open only listed evidence files if implementation detail is still required. Do not scan the whole repository."
      : "No matching memory was found. Fall back to a targeted source search and report the retrieval miss.",
  };
  return {...pack,estimatedTokens:estimateTokens(pack),characterBudget:maxChars,truncated:items.length<Math.min(results.length,limit)};
}
