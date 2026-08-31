import path from "node:path";
import { readJson } from "../utils/fs.js";
import type { MemoryDatabase } from "../memory/database.js";
import type { MemoryType } from "../types.js";
import { hybridSearch } from "./search.js";

interface EvaluationCase {
  name:string;
  query:string;
  repository?:string;
  limit?:number;
  expected:{subjectIncludes?:string;type?:MemoryType;channel?:"sql"|"fts"|"vector"};
}

interface EvaluationFile { cases:EvaluationCase[]; }

export async function runRetrievalEvaluation(memoryDb:MemoryDatabase,file:string):Promise<any> {
  const absolute=path.resolve(file);
  const suite=await readJson<EvaluationFile>(absolute);
  if (!suite?.cases?.length) throw new Error(`Retrieval evaluation has no cases: ${absolute}`);
  const cases=[];
  for (const item of suite.cases) {
    const results=await hybridSearch(memoryDb,item.query,{repo:item.repository,limit:item.limit ?? 5});
    const rank=results.findIndex((result)=>
      (!item.expected.subjectIncludes || result.subject.includes(item.expected.subjectIncludes)) &&
      (!item.expected.type || result.type===item.expected.type) &&
      (!item.expected.channel || result.channels.includes(item.expected.channel)),
    );
    cases.push({name:item.name,passed:rank>=0,rank:rank>=0 ? rank+1 : null,expected:item.expected,topResults:results.slice(0,3).map((result)=>({subject:result.subject,type:result.type,channels:result.channels}))});
  }
  const passed=cases.filter((item)=>item.passed).length;
  return {file:absolute,total:cases.length,passed,failed:cases.length-passed,recallAtK:Number((passed/cases.length).toFixed(4)),cases};
}
