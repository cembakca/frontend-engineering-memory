import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory/database.js";
import { MemoryTools } from "../src/mcp/tools.js";
import { AnswerFeedback } from "../src/telemetry/answer-feedback.js";
import { queryHash } from "../src/telemetry/retrieval-telemetry.js";
import { configureTestNativeBinding } from "./native-binding.js";

await configureTestNativeBinding();

async function withDatabase<T>(run:(memoryDb:MemoryDatabase)=>Promise<T>|T):Promise<T> {
  process.env.MEMORY_EMBEDDINGS_ENABLED="0";
  const root=await mkdtemp(path.join(os.tmpdir(),"fem-feedback-"));
  const memoryDb=new MemoryDatabase(path.join(root,"memory.sqlite"));
  try {
    memoryDb.db.prepare("INSERT INTO repositories(name,path,next_version,router_type,last_indexed_sha) VALUES(?,?,?,?,?)")
      .run("fixture","/fixture","16.3.0","app","a".repeat(40));
    const memory=memoryDb.db.prepare(
      "INSERT INTO memories(repository_id,memory_type,subject,content,confidence,created_sha,updated_sha) VALUES(1,'configuration','GATEWAY_URL','GATEWAY_URL configures the gateway.','verified',?,?)",
    ).run("a".repeat(40),"a".repeat(40));
    const memoryId=Number(memory.lastInsertRowid);
    memoryDb.db.prepare("INSERT INTO memory_evidence(memory_id,file_path,start_line,end_line,commit_sha) VALUES(?,?,?,?,?)")
      .run(memoryId,"src/lib/gateway.ts",9,9,"a".repeat(40));
    memoryDb.db.prepare("INSERT INTO memory_fts(memory_id,repository_id,memory_type,subject,content) VALUES(?,1,'configuration','GATEWAY_URL','GATEWAY_URL configures the gateway.')")
      .run(memoryId);
    return await run(memoryDb);
  } finally {
    memoryDb.close();
    await rm(root,{recursive:true,force:true});
  }
}

test("a retrieval hands back the event id a later report can point at",async()=>{
  await withDatabase(async(memoryDb)=>{
    const tools=new MemoryTools(memoryDb);
    const pack=await tools.context("GATEWAY_URL nerede tanımlı?",{repository:"fixture"}) as any;
    assert.ok(Number.isInteger(pack.telemetryEventId),"the pack must expose its telemetry event id");

    const feedback=new AnswerFeedback(memoryDb);
    const recorded=feedback.record({repository:"fixture",signal:"wrong",retrievalEventId:pack.telemetryEventId,note:"redirect değil"});
    const row=memoryDb.db.prepare("SELECT * FROM answer_feedback WHERE id=?").get(recorded.id) as any;
    assert.equal(row.retrieval_event_id,pack.telemetryEventId);
    assert.equal(row.backlog_state,"new");
    assert.ok(row.snapshot_sha,"the report must be pinned to the snapshot it was about");
  });
});

test("accepts a report without an event by hashing the question the same way",async()=>{
  await withDatabase((memoryDb)=>{
    const recorded=new AnswerFeedback(memoryDb).record({repository:"fixture",signal:"stale",query:"Menü nereden geliyor?"});
    assert.equal(recorded.queryHash,queryHash("Menü nereden geliyor?"));
  });
});

test("rejects an unknown signal and an unknown event",async()=>{
  await withDatabase((memoryDb)=>{
    const feedback=new AnswerFeedback(memoryDb);
    assert.throws(()=>feedback.record({repository:"fixture",signal:"maybe" as any,query:"x"}),/Unknown feedback signal/);
    assert.throws(()=>feedback.record({repository:"fixture",signal:"wrong",retrievalEventId:9999}),/Retrieval event not found/);
    assert.throws(()=>feedback.record({repository:"fixture",signal:"wrong"}),/needs either retrievalEventId or query/);
  });
});

test("turns an actionable report into a draft evaluation case with an owner",async()=>{
  await withDatabase((memoryDb)=>{
    const feedback=new AnswerFeedback(memoryDb);
    // A retrieval that classified the question fine but still needed the source:
    // that is a coverage problem, not an intent problem.
    memoryDb.db.prepare(
      "INSERT INTO retrieval_events(repository_id,tool,intent,pack_kind,query_hash,query_shape_json,miss_class,result_count,fallback) "+
      "VALUES(1,'memory_context','explain-flow','flow',?,'{\"words\":6}',NULL,4,'targeted-source')",
    ).run(queryHash("iletişim formu nasıl gönderiliyor?"));
    feedback.record({repository:"fixture",signal:"source-needed",query:"iletişim formu nasıl gönderiliyor?"});

    const backlog=feedback.backlog("fixture");
    assert.equal(backlog.entries.length,1);
    const entry=backlog.entries[0];
    assert.equal(entry.signal,"source-needed");
    assert.equal(entry.state,"new");
    assert.equal(entry.draftCase.job,"flow","the draft case inherits the job from the planned intent");
    assert.equal(entry.draftCase.policy,"targeted-source");
    assert.ok(entry.draftCase.id.startsWith("RCE-FB-"));
    assert.match(entry.suggestedOwner,/RCE-010|RCE-016/);
    assert.equal(entry.retrieval.intent,"explain-flow","triage must see what the engine planned");
    assert.ok(entry.draftCase.questionMissing,"question text is absent unless telemetry opt-in was on");
  });
});

test("keeps a sufficient report out of the backlog but inside the summary",async()=>{
  await withDatabase((memoryDb)=>{
    const feedback=new AnswerFeedback(memoryDb);
    feedback.record({repository:"fixture",signal:"sufficient",query:"iyi cevap"});
    feedback.record({repository:"fixture",signal:"wrong",query:"kötü cevap"});

    assert.equal(feedback.backlog("fixture").entries.length,1,"a positive control is not backlog");
    const summary=feedback.summary("fixture");
    assert.equal(summary.total,2);
    assert.equal(summary.bySignal.sufficient,1);
    assert.equal(summary.actionable,1);
    assert.equal(summary.actionableRate,0.5);
  });
});

test("moves an entry through triage and requires a case id to close it",async()=>{
  await withDatabase((memoryDb)=>{
    const feedback=new AnswerFeedback(memoryDb);
    const recorded=feedback.record({repository:"fixture",signal:"wrong",query:"yanlış cevap"});
    assert.throws(()=>feedback.updateState(recorded.queryHash,"wrong","case-created"),/requires the evaluation case id/);
    assert.equal(feedback.updateState(recorded.queryHash,"wrong","triaged"),1);
    assert.equal(feedback.updateState(recorded.queryHash,"wrong","case-created","RCE-E03"),1);
    const row=memoryDb.db.prepare("SELECT backlog_state,case_id FROM answer_feedback").get() as any;
    assert.equal(row.backlog_state,"case-created");
    assert.equal(row.case_id,"RCE-E03");
  });
});

test("links a report made by question to the matching retrieval and routes it by cause",async()=>{
  await withDatabase(async(memoryDb)=>{
    const tools=new MemoryTools(memoryDb);
    const question="Değişiklikten sonra hangi komutları çalıştırmalıyım?";
    await tools.context(question,{repository:"fixture"});

    const feedback=new AnswerFeedback(memoryDb);
    feedback.record({repository:"fixture",signal:"wrong",query:question,note:"verify olmalıydı"});

    const entry=feedback.backlog("fixture").entries[0];
    assert.ok(entry.retrieval.intent,"a report made by question must still attach the retrieval it is about");
    assert.equal(
      entry.suggestedOwner,
      "RCE-014 intent model / RCE-015 query plan",
      "a wrong answer on an unclassified question belongs to the intent model, not the analyzer",
    );
  });
});

test("routes a wrong answer on a classified question to the analyzer instead",async()=>{
  await withDatabase((memoryDb)=>{
    const feedback=new AnswerFeedback(memoryDb);
    memoryDb.db.prepare(
      "INSERT INTO retrieval_events(repository_id,tool,intent,pack_kind,query_hash,query_shape_json,miss_class) VALUES(1,'memory_context','explain-flow','flow',?,'{}',NULL)",
    ).run(queryHash("akış nasıl?"));
    feedback.record({repository:"fixture",signal:"wrong",query:"akış nasıl?"});
    assert.match(feedback.backlog("fixture").entries[0].suggestedOwner,/RCE-008/);
  });
});
