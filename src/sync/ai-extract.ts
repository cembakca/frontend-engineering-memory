import { assertRepositorySnapshot } from "../git/git.js";
import type { MemoryDatabase } from "../memory/database.js";
import { MemoryStore } from "../memory/store.js";
import { persistVectors, prepareVectors } from "../memory/vectorize.js";
import type { RepositoryConfig } from "../types.js";
import { extractAiMemories, HttpAiExtractionProvider, type AiExtractionProvider } from "../extractors/ai.js";

export async function runAiExtraction(
  config:RepositoryConfig,
  memoryDb:MemoryDatabase,
  options:{sourceFiles?:string[];provider?:AiExtractionProvider}={},
):Promise<any> {
  const store=new MemoryStore(memoryDb);
  const repository=store.getRepository(config.name) as {id:number;last_indexed_sha:string|null}|undefined;
  if (!repository?.last_indexed_sha) throw new Error(`Run full index before AI extraction: ${config.name}`);
  const head=await assertRepositorySnapshot(config.path,config.mainBranch ?? "main",repository.last_indexed_sha);
  const sourceFiles=options.sourceFiles?.length
    ? options.sourceFiles
    : [...new Set(store.listRoutes(config.name).map((route:any)=>route.source_file as string))];
  const provider=options.provider ?? HttpAiExtractionProvider.fromEnvironment();
  const extracted=await extractAiMemories(config.path,config.name,sourceFiles,provider);
  const prepared=await store.prepareMemories(config.path,extracted.memories);
  const partition=store.partitionPreparedMemories(repository.id,prepared);
  const reusedIds=new Set(partition.reused.map((item)=>item.id));
  const missingReused=store.vectorEnabled ? partition.reused.filter((item)=>!memoryDb.vectorStore?.has(item.id)) : [];
  const vectorRows=[...partition.fresh,...missingReused.map((item)=>item.row)];
  const vectors=await prepareVectors(memoryDb,vectorRows);
  let created=0; let deactivated=0;
  store.transaction(()=>{
    const runId=store.beginRun(repository.id,"INCREMENTAL",head,head,"AI_EXTRACTION");
    deactivated=store.deactivateAiMemoriesForSources(repository.id,sourceFiles,head,runId,reusedIds);
    const ids=store.insertPreparedMemories(repository.id,partition.fresh,head,runId);
    persistVectors(store,[...ids,...missingReused.map((item)=>item.id)],vectors);
    store.recordReusedMemories(runId,partition.reused);
    created=ids.length;
    store.finishRun(runId,{changedFiles:sourceFiles.length,memoriesCreated:created,memoriesDeleted:deactivated});
  });
  return {type:"AI_EXTRACTION",repository:config.name,sha:head,filesRequested:sourceFiles.length,providerCalls:extracted.calls,memoriesCreated:created,memoriesReused:partition.reused.length,memoriesDeactivated:deactivated,rejections:extracted.rejections};
}
