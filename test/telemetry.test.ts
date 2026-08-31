import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { MemoryTools } from "../src/mcp/tools.js";
import { RetrievalTelemetry, deriveMissClass, queryHash, queryShape } from "../src/telemetry/retrieval-telemetry.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

const SECRET_FACT="GATEWAY_URL points at http://gatewayapi.gateways and unlocks the private upstream.";

async function withDatabase<T>(run:(memoryDb:MemoryDatabase)=>Promise<T>|T):Promise<T> {
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-telemetry-"));
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  try {
    memoryDb.db.prepare("INSERT INTO repositories(name,path,next_version,router_type,last_indexed_sha) VALUES(?,?,?,?,?)")
      .run("fixture","/fixture","16.3.0","app","a".repeat(40));
    const memory=memoryDb.db.prepare(
      "INSERT INTO memories(repository_id,memory_type,subject,content,confidence,created_sha,updated_sha) VALUES(1,'configuration','GATEWAY_URL',?,'verified',?,?)",
    ).run(SECRET_FACT,"a".repeat(40),"a".repeat(40));
    const memoryId=Number(memory.lastInsertRowid);
    memoryDb.db.prepare("INSERT INTO memory_evidence(memory_id,file_path,start_line,end_line,commit_sha) VALUES(?,?,?,?,?)")
      .run(memoryId,"src/lib/gateway.ts",9,9,"a".repeat(40));
    memoryDb.db.prepare("INSERT INTO memory_fts(memory_id,repository_id,memory_type,subject,content) VALUES(?,1,'configuration','GATEWAY_URL',?)")
      .run(memoryId,SECRET_FACT);
    return await run(memoryDb);
  } finally {
    memoryDb.close();
    await rm(root,{recursive:true,force:true});
  }
}

test("records a retrieval without storing the question text by default",async()=>{
  delete process.env.MEMORY_TELEMETRY_QUERY_TEXT;
  await withDatabase(async(memoryDb)=>{
    const tools=new MemoryTools(memoryDb);
    await tools.context("GATEWAY_URL hangi dosyada tanımlı?",{repository:"fixture"});
    const row=memoryDb.db.prepare("SELECT * FROM retrieval_events ORDER BY id DESC LIMIT 1").get() as any;
    assert.equal(row.tool,"memory_context");
    assert.equal(row.query_text,null,"question prose is not stored unless explicitly enabled");
    assert.equal(row.query_hash,queryHash("GATEWAY_URL hangi dosyada tanımlı?"));
    assert.ok(row.latency_ms>=0);
    assert.ok(row.payload_chars>0);
    const shape=JSON.parse(row.query_shape_json);
    assert.equal(shape.turkish,true);
    assert.equal(shape.hasConfigKey,true);
  });
});

test("stores the question only when telemetry query text is opted in",async()=>{
  process.env.MEMORY_TELEMETRY_QUERY_TEXT="1";
  try {
    await withDatabase(async(memoryDb)=>{
      const tools=new MemoryTools(memoryDb);
      await tools.context("menu nereden geliyor?",{repository:"fixture"});
      const row=memoryDb.db.prepare("SELECT query_text FROM retrieval_events ORDER BY id DESC LIMIT 1").get() as any;
      assert.equal(row.query_text,"menu nereden geliyor?");
    });
  } finally { delete process.env.MEMORY_TELEMETRY_QUERY_TEXT; }
});

test("never writes fact content into the telemetry table",async()=>{
  process.env.MEMORY_TELEMETRY_QUERY_TEXT="1";
  try {
    await withDatabase(async(memoryDb)=>{
      const tools=new MemoryTools(memoryDb);
      await tools.context("GATEWAY_URL ne yapar?",{repository:"fixture"});
      const rows=memoryDb.db.prepare("SELECT * FROM retrieval_events").all() as any[];
      const serialized=JSON.stringify(rows);
      assert.ok(rows.length>0,"an event must have been recorded");
      assert.equal(serialized.includes("gatewayapi.gateways"),false,"an upstream value must never reach telemetry");
      assert.equal(serialized.includes("unlocks the private upstream"),false,"fact content must never reach telemetry");
      // The identifier itself is fine: it already lives in the index and is not a secret.
      assert.ok(rows.some((row)=>String(row.result_ids_json).includes("GATEWAY_URL")));
    });
  } finally { delete process.env.MEMORY_TELEMETRY_QUERY_TEXT; }
});

test("a telemetry failure never breaks the answer",async()=>{
  await withDatabase(async(memoryDb)=>{
    const tools=new MemoryTools(memoryDb);
    memoryDb.db.exec("DROP TABLE retrieval_events");
    const pack=await tools.context("GATEWAY_URL nerede?",{repository:"fixture"});
    assert.ok(pack,"retrieval must still answer when telemetry cannot write");
  });
});

test("prunes to the newest events and reports aggregates",async()=>{
  await withDatabase(async(memoryDb)=>{
    const telemetry=new RetrievalTelemetry(memoryDb);
    for (let index=0;index<12;index+=1) {
      telemetry.record({repository:"fixture",tool:"memory_context",query:`soru ${index}`,intent:"lookup",
        resultCount:index%3===0 ? 0 : 2,latencyMs:index*10,estimatedTokens:100+index,
        fallback:index%4===0 ? "targeted-source" : "none"});
    }
    assert.equal(telemetry.prune(5),7);
    const report=telemetry.report("fixture");
    assert.equal(report.events,5);
    assert.ok(report.latencyMs.p50!==null);
    assert.ok(report.missRate!==null);
    assert.ok(Object.keys(report.byIntent).includes("lookup"));
  });
});

test("classifies the misses the engine can tell apart and leaves the rest null",()=>{
  assert.equal(deriveMissClass({repository:null,tool:"t",gaps:["flow seed could not be resolved"]}),"wrong-intent");
  assert.equal(deriveMissClass({repository:null,tool:"t",resultCount:0}),"missing-fact");
  assert.equal(deriveMissClass({repository:null,tool:"t",resultCount:3,fallback:"targeted-source"}),"missing-evidence");
  assert.equal(deriveMissClass({repository:null,tool:"t",resultCount:3,fallback:"none"}),null);
  assert.equal(deriveMissClass({repository:null,tool:"t",error:"boom"}),"engine-error");
});

test("derives a query shape without keeping the question",()=>{
  const shape=queryShape("src/lib/menu.ts değişirse /iletisim etkilenir mi?");
  assert.equal(shape.hasFilePath,true);
  assert.equal(shape.hasRoutePath,true);
  assert.equal(shape.turkish,true);
  assert.equal(shape.lengthBucket,"s");
});
