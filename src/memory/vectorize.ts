import { embeddingsEnabled } from "../config.js";
import type { PreparedMemoryCandidate } from "../types.js";
import type { MemoryDatabase } from "./database.js";
import { MemoryStore } from "./store.js";

export async function prepareVectors(memoryDb:MemoryDatabase,rows:PreparedMemoryCandidate[]):Promise<Float32Array[]|null> {
  if (!embeddingsEnabled() || !memoryDb.vectorStore || !rows.length) return null;
  const { embeddingProvider }=await import("./embeddings.js");
  if (embeddingProvider().dimension!==memoryDb.vectorDimension) {
    throw new Error(`Embedding provider/database dimension mismatch: ${embeddingProvider().dimension}/${memoryDb.vectorDimension}`);
  }
  const vectors:Float32Array[]=[];
  for (let i=0;i<rows.length;i+=32) {
    vectors.push(...await embeddingProvider().embedPassages(rows.slice(i,i+32).map((row)=>row.candidate.content)));
  }
  return vectors;
}

/** Re-embed active facts after a model/profile change without re-running analyzers. */
export async function rebuildVectors(memoryDb:MemoryDatabase,repository?:string):Promise<object> {
  if (!embeddingsEnabled()||!memoryDb.vectorStore) throw new Error("Embeddings/vector store are disabled");
  const rows=memoryDb.db.prepare(`
    SELECT m.id,m.repository_id,m.memory_type,m.content
    FROM memories m JOIN repositories repo ON repo.id=m.repository_id
    WHERE m.active=1 ${repository ? "AND repo.name=?" : ""}
    ORDER BY m.id
  `).all(...(repository ? [repository] : [])) as Array<{id:number;repository_id:number;memory_type:string;content:string}>;
  if (repository&&!rows.length) {
    const exists=memoryDb.db.prepare("SELECT 1 found FROM repositories WHERE name=?").get(repository);
    if (!exists) throw new Error(`Repository not found: ${repository}`);
  }
  const { embeddingProvider }=await import("./embeddings.js");
  const provider=embeddingProvider();
  if (provider.dimension!==memoryDb.vectorDimension) {
    throw new Error(`Embedding provider/database dimension mismatch: ${provider.dimension}/${memoryDb.vectorDimension}`);
  }
  const started=Date.now();
  let written=0;
  for (let index=0;index<rows.length;index+=32) {
    const batch=rows.slice(index,index+32);
    const vectors=await provider.embedPassages(batch.map((row)=>row.content));
    if (vectors.length!==batch.length) throw new Error(`Embedding batch mismatch: ${vectors.length}/${batch.length}`);
    memoryDb.db.transaction(()=>{
      batch.forEach((row,offset)=>memoryDb.vectorStore!.set(row.id,vectors[offset]!,{
        repositoryId:row.repository_id,memoryType:row.memory_type,
      }));
    })();
    written+=vectors.length;
  }
  return {
    repository:repository ?? "all",profile:memoryDb.embeddingProfile.id,model:memoryDb.embeddingProfile.model,
    revision:memoryDb.embeddingProfile.revision,dimension:memoryDb.vectorDimension,vectors:written,
    elapsedMs:Date.now()-started,
  };
}

export function persistVectors(store:MemoryStore,ids:number[],vectors:Float32Array[]|null):void {
  if (!vectors) return;
  if (ids.length!==vectors.length) throw new Error(`Memory/vector count mismatch: ${ids.length}/${vectors.length}`);
  ids.forEach((id,index)=>store.setVector(id,vectors[index]!));
}
