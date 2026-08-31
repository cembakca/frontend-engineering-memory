import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { ProjectionCache, projectRepository } from "../src/ui/projection.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

/** Three tight clusters in 384 dimensions; a correct projection must keep them apart. */
function clusteredVector(cluster:number,jitter:number,dimension=384):Float32Array {
  const vector=new Float32Array(dimension);
  for (let i=0;i<dimension;i+=1) vector[i]=Math.sin((i+1)*(cluster+1))*0.01;
  vector[cluster*40]=1+jitter;
  vector[cluster*40+1]=0.6-jitter;
  let length=0;
  for (const value of vector) length+=value*value;
  length=Math.sqrt(length)||1;
  for (let i=0;i<dimension;i+=1) vector[i]/=length;
  return vector;
}

async function withDatabase<T>(run:(memoryDb:MemoryDatabase)=>Promise<T>|T):Promise<T> {
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-projection-"));
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  try {
    memoryDb.db.prepare("INSERT INTO repositories(name,path,router_type,last_indexed_sha) VALUES(?,?,?,?)")
      .run("fixture","/fixture","app","a".repeat(40));
    for (let cluster=0;cluster<3;cluster+=1) {
      for (let member=0;member<4;member+=1) {
        const row=memoryDb.db.prepare(
          "INSERT INTO memories(repository_id,memory_type,subject,content,confidence,created_sha,updated_sha) VALUES(1,?,?,?,'verified',?,?)",
        ).run(`type_${cluster}`,`subject-${cluster}-${member}`,`fact ${cluster}.${member}`,"a".repeat(40),"a".repeat(40));
        const id=Number(row.lastInsertRowid);
        memoryDb.db.prepare("INSERT INTO memory_evidence(memory_id,file_path,start_line,end_line,commit_sha) VALUES(?,?,?,?,?)")
          .run(id,`src/cluster-${cluster}.ts`,member+1,member+1,"a".repeat(40));
        memoryDb.vectorStore?.set(id,clusteredVector(cluster,member*0.01),{repositoryId:1,memoryType:`type_${cluster}`});
      }
    }
    return await run(memoryDb);
  } finally {
    memoryDb.close();
    await rm(root,{recursive:true,force:true});
  }
}

test("projects stored vectors into bounded coordinates and reports what it lost",async()=>{
  await withDatabase((memoryDb)=>{
    if (!memoryDb.vectorEnabled) return;
    const projection=projectRepository(memoryDb,"fixture");
    assert.equal(projection.points.length,12);
    assert.equal(projection.withoutVector,0);
    assert.equal(projection.dimension,384);
    assert.equal(projection.explained.length,3,"the page states how lossy the picture is");
    assert.ok(projection.explained[0]! >= projection.explained[1]!,"components come out ordered");
    for (const point of projection.points) {
      for (const axis of [point.x,point.y,point.z]) {
        assert.ok(axis>=-1.0001&&axis<=1.0001,`axis ${axis} outside the drawable range`);
      }
    }
  });
});

test("keeps unrelated clusters apart in the projected plane",async()=>{
  await withDatabase((memoryDb)=>{
    if (!memoryDb.vectorEnabled) return;
    const points=projectRepository(memoryDb,"fixture").points;
    const centre=(type:string)=>{
      const group=points.filter((point)=>point.type===type);
      return [group.reduce((s,p)=>s+p.x,0)/group.length,group.reduce((s,p)=>s+p.y,0)/group.length];
    };
    const spread=(type:string)=>{
      const [cx,cy]=centre(type);
      const group=points.filter((point)=>point.type===type);
      return Math.max(...group.map((p)=>Math.hypot(p.x-cx,p.y-cy)));
    };
    const [ax,ay]=centre("type_0");
    const [bx,by]=centre("type_1");
    assert.ok(Math.hypot(ax-bx,ay-by)>Math.max(spread("type_0"),spread("type_1")),
      "two clusters must sit further apart than either is wide");
  });
});

test("returns neighbours from the index with cosine similarity, nearest first",async()=>{
  await withDatabase((memoryDb)=>{
    if (!memoryDb.vectorEnabled) return;
    const cache=new ProjectionCache(memoryDb);
    const first=cache.get("fixture").points.find((point)=>point.type==="type_0")!;
    const neighbours=cache.neighbours("fixture",first.id,4);
    assert.ok(neighbours.length>0);
    assert.equal(neighbours.some((item)=>item.id===first.id),false,"a fact is not its own neighbour");
    for (const item of neighbours) assert.ok(item.similarity<=1.0001&&item.similarity>=-1.0001,`similarity ${item.similarity} out of range`);
    for (let i=1;i<neighbours.length;i+=1) {
      assert.ok(neighbours[i-1]!.similarity>=neighbours[i]!.similarity,"neighbours come back nearest first");
    }
    assert.equal(neighbours[0]!.type,"type_0","the nearest neighbour is from the same cluster");
  });
});

test("caches a projection per snapshot and rebuilds when the index moves",async()=>{
  await withDatabase((memoryDb)=>{
    if (!memoryDb.vectorEnabled) return;
    const cache=new ProjectionCache(memoryDb);
    const first=cache.get("fixture");
    assert.equal(cache.get("fixture"),first,"the same snapshot returns the very same object");

    memoryDb.db.prepare("UPDATE repositories SET last_indexed_sha=? WHERE name='fixture'").run("b".repeat(40));
    const second=cache.get("fixture");
    assert.notEqual(second,first,"a new snapshot invalidates the cached picture");
    assert.equal(second.snapshotSha,"b".repeat(40));
    assert.equal(second.points.length,12,"and still projects every fact");
  });
});

test("refuses a repository it does not know",async()=>{
  await withDatabase((memoryDb)=>{
    assert.throws(()=>projectRepository(memoryDb,"absent"),/Repository not found/);
  });
});
