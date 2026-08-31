import type { MemoryDatabase } from "../memory/database.js";
import { MemoryStore } from "../memory/store.js";

/**
 * Server-side projection of the stored embeddings for the browser UI.
 *
 * The vectors stay in the database; only two or three coordinates per fact ever
 * reach the page. The projection is honest about being lossy — the explained
 * variance is returned alongside the points so the UI can state it.
 */
export interface ProjectedPoint {
  id:number;
  type:string;
  subject:string;
  content:string;
  file:string|null;
  evidenceCount:number;
  x:number;
  y:number;
  z:number;
}

export interface Projection {
  repository:string;
  snapshotSha:string|null;
  dimension:number;
  /** Share of total variance each principal component carries. */
  explained:number[];
  points:ProjectedPoint[];
  /** Facts with no embedding, e.g. when the index ran with embeddings disabled. */
  withoutVector:number;
}

function decode(buffer:Buffer):Float32Array {
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength));
}

/** Top principal components by power iteration with deflation. Adequate for a few hundred rows. */
function principalComponents(rows:number[][],dimension:number,count:number):{components:number[][];eigenvalues:number[]} {
  const multiply=(vector:number[]):number[]=>{
    const out=new Array(dimension).fill(0);
    for (const row of rows) {
      let dot=0;
      for (let i=0;i<dimension;i+=1) dot+=row[i]!*vector[i]!;
      for (let i=0;i<dimension;i+=1) out[i]+=row[i]!*dot;
    }
    return out.map((value)=>value/rows.length);
  };
  const norm=(vector:number[]):number=>Math.sqrt(vector.reduce((sum,value)=>sum+value*value,0));

  const components:number[][]=[];
  const eigenvalues:number[]=[];
  // Deterministic seed: the same index must always project to the same picture.
  let seed=42;
  const random=()=>{ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff-0.5; };

  for (let k=0;k<count;k+=1) {
    let vector=new Array(dimension).fill(0).map(random);
    for (let iteration=0;iteration<220;iteration+=1) {
      const next=multiply(vector);
      for (const component of components) {
        const dot=next.reduce((sum,value,index)=>sum+value*component[index]!,0);
        for (let i=0;i<dimension;i+=1) next[i]-=dot*component[i]!;
      }
      const length=norm(next);
      if (length<1e-12) break;
      vector=next.map((value)=>value/length);
    }
    const applied=multiply(vector);
    eigenvalues.push(applied.reduce((sum,value,index)=>sum+value*vector[index]!,0));
    components.push(vector);
  }
  return {components,eigenvalues};
}

export function projectRepository(memoryDb:MemoryDatabase,repository:string):Projection {
  const store=new MemoryStore(memoryDb);
  const row=store.getRepository(repository);
  if (!row) throw new Error(`Repository not found: ${repository}`);

  const facts=memoryDb.db.prepare(`
    SELECT m.id,m.memory_type type,m.subject,m.content,
           (SELECT MIN(e.file_path) FROM memory_evidence e WHERE e.memory_id=m.id) file,
           (SELECT COUNT(*) FROM memory_evidence e WHERE e.memory_id=m.id) evidenceCount
    FROM memories m WHERE m.active=1 AND m.repository_id=? ORDER BY m.id
  `).all(row.id) as any[];

  const vectors=new Map<number,Float32Array>();
  try {
    for (const item of memoryDb.db.prepare("SELECT rowid, embedding FROM memory_vectors_v2 WHERE repository_id=?").all(row.id) as any[]) {
      vectors.set(Number(item.rowid),decode(item.embedding as Buffer));
    }
  } catch { /* vector table unavailable; the UI degrades to a list */ }

  const embedded=facts.filter((fact)=>vectors.has(fact.id));
  const dimension=memoryDb.vectorDimension;
  const base={repository,snapshotSha:(row.last_indexed_sha as string|null) ?? null,dimension,
    withoutVector:facts.length-embedded.length};
  if (embedded.length<3) return {...base,explained:[],points:[]};

  const raw=embedded.map((fact)=>Array.from(vectors.get(fact.id)!));
  const mean=new Array(dimension).fill(0);
  for (const vector of raw) for (let i=0;i<dimension;i+=1) mean[i]+=vector[i]!/raw.length;
  const centred=raw.map((vector)=>vector.map((value,index)=>value-mean[index]!));

  const {components,eigenvalues}=principalComponents(centred,dimension,3);
  const totalVariance=centred.reduce((sum,row2)=>sum+row2.reduce((a,value)=>a+value*value,0),0)/centred.length;
  const coordinates=centred.map((row2)=>components.map((component)=>row2.reduce((sum,value,index)=>sum+value*component[index]!,0)));
  const bounds=[0,1,2].map((axis)=>{
    const values=coordinates.map((c)=>c[axis]!);
    return {min:Math.min(...values),max:Math.max(...values)};
  });
  const scale=(value:number,axis:number):number=>{
    const {min,max}=bounds[axis]!;
    return max>min ? Number((((value-min)/(max-min))*2-1).toFixed(4)) : 0;
  };

  return {
    ...base,
    explained:eigenvalues.map((value)=>Number((value/totalVariance).toFixed(4))),
    points:embedded.map((fact,index)=>({
      id:fact.id,type:fact.type,subject:fact.subject,
      content:String(fact.content).slice(0,300),
      file:fact.file ?? null,evidenceCount:fact.evidenceCount,
      x:scale(coordinates[index]![0]!,0),y:scale(coordinates[index]![1]!,1),z:scale(coordinates[index]![2]!,2),
    })),
  };
}

/** Cached per repository and snapshot: the picture only changes when the index does. */
export class ProjectionCache {
  private readonly entries=new Map<string,Projection>();
  constructor(private readonly memoryDb:MemoryDatabase) {}

  get(repository:string):Projection {
    const row=new MemoryStore(this.memoryDb).getRepository(repository);
    const key=`${repository}:${row?.last_indexed_sha ?? "none"}`;
    const cached=this.entries.get(key);
    if (cached) return cached;
    const projection=projectRepository(this.memoryDb,repository);
    this.entries.set(key,projection);
    return projection;
  }

  /** Nearest neighbours of one stored fact, taken from sqlite-vec rather than recomputed. */
  neighbours(repository:string,memoryId:number,limit=6):Array<{id:number;similarity:number;type:string;subject:string;file:string|null}> {
    const store=new MemoryStore(this.memoryDb);
    const row=store.getRepository(repository);
    if (!row||!this.memoryDb.vectorStore) return [];
    const record=this.memoryDb.db.prepare("SELECT embedding FROM memory_vectors_v2 WHERE rowid=?").get(BigInt(memoryId)) as any;
    if (!record) return [];
    return this.hydrate(row.id,decode(record.embedding as Buffer),limit+1).filter((item)=>item.id!==memoryId).slice(0,limit);
  }

  /** Nearest neighbours of an arbitrary query vector, for live search from the UI. */
  search(repository:string,vector:Float32Array,limit=6):Array<{id:number;similarity:number;type:string;subject:string;file:string|null}> {
    const row=new MemoryStore(this.memoryDb).getRepository(repository);
    if (!row||!this.memoryDb.vectorStore) return [];
    return this.hydrate(row.id,vector,limit);
  }

  private hydrate(repositoryId:number,vector:Float32Array,limit:number):Array<{id:number;similarity:number;type:string;subject:string;file:string|null}> {
    const matches=this.memoryDb.vectorStore!.search(vector,{repositoryId,limit});
    if (!matches.length) return [];
    const placeholders=matches.map(()=>"?").join(",");
    const rows=this.memoryDb.db.prepare(`
      SELECT m.id,m.memory_type type,m.subject,
             (SELECT MIN(e.file_path) FROM memory_evidence e WHERE e.memory_id=m.id) file
      FROM memories m WHERE m.id IN (${placeholders}) AND m.active=1
    `).all(...matches.map((match)=>match.id)) as any[];
    const byId=new Map(rows.map((item)=>[Number(item.id),item]));
    return matches.flatMap((match)=>{
      const item=byId.get(match.id);
      if (!item) return [];
      // sqlite-vec returns L2 distance over normalized vectors: cosine = 1 - d²/2.
      const similarity=Math.max(-1,Math.min(1,1-(match.distance*match.distance)/2));
      return [{id:match.id,similarity:Number(similarity.toFixed(4)),type:item.type,subject:item.subject,file:item.file ?? null}];
    });
  }
}
