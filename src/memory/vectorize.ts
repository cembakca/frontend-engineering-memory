import { embeddingsEnabled } from "../config.js";
import type { PreparedMemoryCandidate } from "../types.js";
import type { MemoryDatabase } from "./database.js";
import { MemoryStore } from "./store.js";

export async function prepareVectors(memoryDb:MemoryDatabase,rows:PreparedMemoryCandidate[]):Promise<Float32Array[]|null> {
  if (!embeddingsEnabled() || !memoryDb.vectorStore || !rows.length) return null;
  const { embeddingProvider }=await import("./embeddings.js");
  const vectors:Float32Array[]=[];
  for (let i=0;i<rows.length;i+=32) {
    vectors.push(...await embeddingProvider().embedPassages(rows.slice(i,i+32).map((row)=>row.candidate.content)));
  }
  return vectors;
}

export function persistVectors(store:MemoryStore,ids:number[],vectors:Float32Array[]|null):void {
  if (!vectors) return;
  if (ids.length!==vectors.length) throw new Error(`Memory/vector count mismatch: ${ids.length}/${vectors.length}`);
  ids.forEach((id,index)=>store.setVector(id,vectors[index]!));
}
