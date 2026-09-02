import type { MemoryDatabase } from "../memory/database.js";
import { MemoryStore } from "../memory/store.js";
import type { MemoryType } from "../types.js";
import { hybridSearch } from "./search.js";
import { claimKindForConfidence, createAnswerContract } from "./answer-contract.js";

function truncate(value:string,max:number):string {
  return value.length<=max ? value : `${value.slice(0,Math.max(0,max-1))}…`;
}

function estimateTokens(value:unknown):number {
  return Math.ceil(JSON.stringify(value).length/3.5);
}

export async function buildAgentContext(
  memoryDb:MemoryDatabase,
  query:string,
  options:{repository?:string;memoryTypes?:MemoryType[];limit?:number;maxChars?:number;metadata?:Record<string,unknown>;uncertainty?:string[]}={},
):Promise<any> {
  const limit=Math.max(1,Math.min(10,options.limit ?? 5));
  const maxChars=Math.max(1000,Math.min(24000,options.maxChars ?? 8000));
  const store=new MemoryStore(memoryDb);
  const results=await hybridSearch(memoryDb,query,{repo:options.repository,memoryTypes:options.memoryTypes,limit:limit*2});
  const evidence=store.memoryEvidence(results.flatMap((item)=>[item.id,...(item.duplicateIds ?? [])]).filter((id)=>id>0));
  const items:any[]=[];
  for (const result of results) {
    const sourceEvidence=[result.id,...(result.duplicateIds ?? [])].flatMap((id)=>evidence.get(id) ?? [])
      .filter((row:any,index:number,all:any[])=>all.findIndex((item:any)=>item.file_path===row.file_path&&item.symbol===row.symbol&&item.start_line===row.start_line)===index);
    const item={
      claimKind:claimKindForConfidence(result.confidence),
      id:result.id,
      repository:result.repository,
      type:result.type,
      subject:result.subject,
      fact:truncate(result.content,1200),
      sourceFile:result.sourceFile,
      commitSha:result.commitSha,
      channels:result.channels,
      canonicalEntity:result.canonicalEntity,
      duplicateCount:result.duplicateIds?.length ?? 0,
      evidence:(sourceEvidence.length ? sourceEvidence.slice(0,4).map((row:any)=>({
        file:row.file_path,symbol:row.symbol,startLine:row.start_line,endLine:row.end_line,commitSha:row.commit_sha,
      })) : result.sourceFile ? [{file:result.sourceFile,symbol:null,startLine:null,endLine:null,commitSha:result.commitSha}] : []),
    };
    const candidate={query,items:[...items,item]};
    if (JSON.stringify(candidate).length>maxChars && items.length) break;
    items.push(item);
    if (items.length>=limit) break;
  }
  /** Distinguishes "nothing matched" from "matches did not fit the budget"; the two need different next steps. */
  const finish=(selected:typeof items,droppedForBudget=false)=>{
    const truncated=selected.length<Math.min(results.length,limit);
    const missingEvidence=selected.flatMap((item,index)=>item.evidence.length ? [] : [{path:`items[${index}]`,reason:"fact has no located source evidence"}]);
    // Source fallback names files worth opening *because memory is imprecise
    // there* — a fact whose evidence has no line, or a discovery hint when
    // nothing matched. Listing the evidence files of well-located facts would
    // make every answer look insufficient while adding nothing to open.
    const fallback=(selected.length
      ? selected.filter((item)=>item.evidence.length&&!item.evidence.some((entry:any)=>entry.startLine!=null))
        .flatMap((item)=>item.evidence.map((entry:any)=>entry.file))
      : results.flatMap((item)=>item.sourceFiles ?? (item.sourceFile ? [item.sourceFile] : [])).slice(0,4)
    ).filter(Boolean) as string[];
    const answerContract=createAnswerContract({
      facts:selected.some((item)=>item.claimKind==="fact") ? ["items[claimKind=fact]"] : [],
      inferences:selected.some((item)=>item.claimKind==="inference") ? ["items[claimKind=inference]"] : [],
      uncertainty:[...(options.uncertainty ?? []),
        ...(selected.length ? [] : droppedForBudget
          ? [`matching memory was found but did not fit maxChars=${maxChars}; raise the budget`]
          : ["no matching memory was found"])],
      missingEvidence,sourceFallback:fallback,truncated,empty:!selected.length,
    });
    const usedChars=0;
    const complete={...options.metadata,query,repository:options.repository ?? null,items:selected,
      guidance:selected.length ? "Follow answerContract."
        : droppedForBudget ? "Matches exist but exceed maxChars; raise the budget rather than reporting a miss."
        : "No match; report the miss and use targeted fallback.",
      answerContract,truncated,
      ...(droppedForBudget ? {budgetExceeded:true} : {})};
    // Same budget shape as the compiled packs, so a caller (and the UI) reads
    // one field regardless of which retrieval path produced the payload.
    const withBudget={...complete,budget:{maxChars,usedChars,estimatedTokens:0,truncated,omitted:{}}};
    const measured=JSON.stringify(withBudget).length;
    withBudget.budget.usedChars=measured;
    withBudget.budget.estimatedTokens=Math.ceil(measured/3.5);
    return {...withBudget,estimatedTokens:estimateTokens(withBudget)};
  };
  let complete=finish(items);
  let droppedForBudget=false;
  while (JSON.stringify(complete).length>maxChars&&items.length) {
    items.pop();
    droppedForBudget=true;
    complete=finish(items,droppedForBudget);
  }
  return complete;
}
