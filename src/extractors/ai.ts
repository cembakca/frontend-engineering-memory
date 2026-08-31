import path from "node:path";
import { readTextIfSmall } from "../utils/fs.js";
import type { MemoryCandidate } from "../types.js";

export interface AiExtractionRequest {
  repository:string;
  sourceFile:string;
  source:string;
  allowedTypes:Array<"business_capability"|"business_rule">;
}

export interface AiExtractionProvider {
  extract(request:AiExtractionRequest):Promise<unknown>;
}

interface AiMemoryOutput {
  type:"business_capability"|"business_rule";
  subject:string;
  content:string;
  confidence:number;
  evidence:{filePath:string;startLine:number;endLine:number;quote:string;symbol?:string|null};
}

export class HttpAiExtractionProvider implements AiExtractionProvider {
  constructor(private readonly url:string,private readonly token?:string) {}

  static fromEnvironment():HttpAiExtractionProvider {
    const url=process.env.MEMORY_AI_EXTRACTOR_URL;
    if (!url) throw new Error("MEMORY_AI_EXTRACTOR_URL is required for ai-extract");
    return new HttpAiExtractionProvider(url,process.env.MEMORY_AI_EXTRACTOR_TOKEN);
  }

  async extract(request:AiExtractionRequest):Promise<unknown> {
    const response=await fetch(this.url,{
      method:"POST",
      headers:{"content-type":"application/json",...(this.token ? {authorization:`Bearer ${this.token}`} : {})},
      body:JSON.stringify({
        schemaVersion:1,
        instruction:"Return only source-grounded business capability/rule memories. Every claim needs an exact quote and valid line range from the supplied source. Do not infer organization, users, revenue, runtime behavior, or intent that the code does not support.",
        outputSchema:{memories:[{type:"business_capability | business_rule",subject:"string <= 160",content:"string <= 1200",confidence:"number 0..1",evidence:{filePath:request.sourceFile,startLine:"integer",endLine:"integer",quote:"exact source quote",symbol:"optional"}}]},
        input:request,
      }),
      signal:AbortSignal.timeout(Number(process.env.MEMORY_AI_EXTRACTOR_TIMEOUT_MS ?? 60000)),
    });
    if (!response.ok) throw new Error(`AI extractor HTTP ${response.status}: ${(await response.text()).slice(0,500)}`);
    return response.json();
  }
}

function isObject(value:unknown):value is Record<string,unknown> { return Boolean(value) && typeof value==="object" && !Array.isArray(value); }

export function validateAiExtraction(
  request:AiExtractionRequest,
  output:unknown,
  minimumConfidence=Number(process.env.MEMORY_AI_MIN_CONFIDENCE ?? 0.8),
):{memories:MemoryCandidate[];rejections:string[]} {
  const raw=isObject(output) && Array.isArray(output.memories) ? output.memories.slice(0,5) : [];
  const memories:MemoryCandidate[]=[];
  const rejections:string[]=[];
  const lines=request.source.split(/\r?\n/);
  raw.forEach((value,index)=>{
    const reject=(reason:string)=>rejections.push(`item ${index}: ${reason}`);
    if (!isObject(value)) return reject("not an object");
    if (value.type!=="business_capability" && value.type!=="business_rule") return reject("unsupported type");
    if (!request.allowedTypes.includes(value.type)) return reject("type was not requested");
    if (typeof value.subject!=="string" || !value.subject.trim() || value.subject.length>160) return reject("invalid subject");
    if (typeof value.content!=="string" || !value.content.trim() || value.content.length>1200) return reject("invalid content");
    if (typeof value.confidence!=="number" || value.confidence<minimumConfidence || value.confidence>1) return reject("confidence below gate or out of range");
    if (!isObject(value.evidence) || value.evidence.filePath!==request.sourceFile) return reject("evidence file mismatch");
    const start=value.evidence.startLine; const end=value.evidence.endLine; const quote=value.evidence.quote;
    if (!Number.isInteger(start) || !Number.isInteger(end) || Number(start)<1 || Number(end)<Number(start) || Number(end)>lines.length) return reject("invalid evidence range");
    if (typeof quote!=="string" || !quote.trim()) return reject("missing evidence quote");
    const range=lines.slice(Number(start)-1,Number(end)).join("\n");
    if (!range.includes(quote)) return reject("evidence quote is not present in the declared range");
    memories.push({
      type:value.type,subject:value.subject.trim(),content:value.content.trim(),confidence:"inferred",producer:"ai",qualityScore:value.confidence,
      sourceFile:request.sourceFile,sourceSymbol:typeof value.evidence.symbol==="string" ? value.evidence.symbol : null,startLine:Number(start),endLine:Number(end),
    });
  });
  if (!raw.length) rejections.push("response contains no memories");
  return {memories,rejections};
}

export async function extractAiMemories(
  repoPath:string,
  repository:string,
  sourceFiles:string[],
  provider:AiExtractionProvider,
):Promise<{memories:MemoryCandidate[];rejections:Array<{sourceFile:string;reason:string}>;calls:number}> {
  const maxFiles=Math.max(1,Math.min(100,Number(process.env.MEMORY_AI_MAX_FILES_PER_RUN ?? 20)));
  const maxChars=Math.max(2000,Math.min(120000,Number(process.env.MEMORY_AI_MAX_SOURCE_CHARS ?? 40000)));
  const memories:MemoryCandidate[]=[]; const rejections:Array<{sourceFile:string;reason:string}>=[];
  let calls=0;
  for (const sourceFile of [...new Set(sourceFiles)].slice(0,maxFiles)) {
    const absolute=path.resolve(repoPath,sourceFile);
    const root=path.resolve(repoPath)+path.sep;
    if (!absolute.startsWith(root)) { rejections.push({sourceFile,reason:"source path escapes repository"}); continue; }
    const content=await readTextIfSmall(absolute,512_000);
    if (!content) { rejections.push({sourceFile,reason:"source file is missing, empty or too large"}); continue; }
    const request:AiExtractionRequest={repository,sourceFile,source:content.slice(0,maxChars),allowedTypes:["business_capability","business_rule"]};
    const output=await provider.extract(request); calls++;
    const validated=validateAiExtraction(request,output);
    memories.push(...validated.memories);
    rejections.push(...validated.rejections.map((reason)=>({sourceFile,reason})));
  }
  return {memories,rejections,calls};
}
