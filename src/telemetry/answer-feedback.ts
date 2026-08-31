import type { MemoryDatabase } from "../memory/database.js";
import { queryHash } from "./retrieval-telemetry.js";

/**
 * RCE-025 answer feedback loop.
 *
 * A signal that only increments a counter changes nothing. Every signal here is
 * pushed towards one outcome: a draft evaluation case in the shape the RCE-002
 * suite already consumes, so a complaint becomes a test rather than an anecdote.
 */
export type FeedbackSignal="sufficient"|"source-needed"|"wrong"|"stale";
export type BacklogState="new"|"triaged"|"case-created"|"dismissed";

const SIGNALS:FeedbackSignal[]=["sufficient","source-needed","wrong","stale"];

/** Signals that demand an evaluation case. `sufficient` is kept as a positive control, not as backlog. */
const ACTIONABLE=new Set<FeedbackSignal>(["source-needed","wrong","stale"]);

/**
 * Which TODO item owns the fix, so triage does not restart the argument each
 * time. The signal alone is too coarse: a `wrong` answer caused by a
 * misclassified question belongs to the intent model, not to the analyzer.
 */
function suggestedOwner(signal:FeedbackSignal,retrieval:{intent?:string|null;missClass?:string|null}):string {
  if (signal==="sufficient") return "none — positive control";
  if (retrieval.missClass==="wrong-intent"||retrieval.intent==="unknown") return "RCE-014 intent model / RCE-015 query plan";
  if (signal==="stale") return "RCE-026 freshness SLO";
  if (signal==="source-needed") return "RCE-010 extraction coverage / RCE-016 ranking";
  return "RCE-008 analyzer semantic correctness / RCE-007 confidence";
}

export interface FeedbackInput {
  repository:string;
  signal:FeedbackSignal;
  /** The telemetry event this is about. When absent the query text is hashed instead. */
  retrievalEventId?:number|null;
  query?:string|null;
  reporter?:string;
  note?:string|null;
  snapshotSha?:string|null;
}

export class AnswerFeedback {
  constructor(private readonly memoryDb:MemoryDatabase) {}

  record(input:FeedbackInput):{id:number;queryHash:string;signal:FeedbackSignal} {
    if (!SIGNALS.includes(input.signal)) throw new Error(`Unknown feedback signal: ${input.signal}`);
    const repository=this.memoryDb.db.prepare("SELECT id,last_indexed_sha FROM repositories WHERE name=?").get(input.repository) as {id:number;last_indexed_sha:string|null}|undefined;
    if (!repository) throw new Error(`Repository not found: ${input.repository}`);

    const event=input.retrievalEventId!=null
      ? this.memoryDb.db.prepare("SELECT id,query_hash,snapshot_sha FROM retrieval_events WHERE id=?").get(input.retrievalEventId) as {id:number;query_hash:string;snapshot_sha:string|null}|undefined
      : undefined;
    if (input.retrievalEventId!=null&&!event) throw new Error(`Retrieval event not found: ${input.retrievalEventId}`);

    const hash=event?.query_hash ?? (input.query ? queryHash(input.query) : null);
    if (!hash) throw new Error("Feedback needs either retrievalEventId or query");

    // Reported by question rather than by event id: attach the most recent matching
    // retrieval so triage still sees what the engine planned and returned.
    const linked=event ?? this.memoryDb.db.prepare(
      "SELECT id,query_hash,snapshot_sha FROM retrieval_events WHERE query_hash=? AND repository_id=? ORDER BY id DESC LIMIT 1",
    ).get(hash,repository.id) as {id:number;query_hash:string;snapshot_sha:string|null}|undefined;

    const result=this.memoryDb.db.prepare(`
      INSERT INTO answer_feedback(repository_id,retrieval_event_id,query_hash,signal,reporter,note,snapshot_sha)
      VALUES(?,?,?,?,?,?,?)
    `).run(repository.id,linked?.id ?? null,hash,input.signal,input.reporter ?? "unknown",input.note ?? null,
      input.snapshotSha ?? linked?.snapshot_sha ?? repository.last_indexed_sha ?? null);

    return {id:Number(result.lastInsertRowid),queryHash:hash,signal:input.signal};
  }

  /**
   * Open backlog, grouped by question. Each entry carries the retrieval facts
   * telemetry already knows, so triage does not have to reproduce the call.
   */
  backlog(repository?:string,options:{state?:BacklogState;limit?:number}={}):any {
    const limit=Math.max(1,Math.min(200,options.limit ?? 50));
    const conditions=["f.signal != 'sufficient'"];
    const params:Record<string,unknown>={limit};
    if (repository) { conditions.push("repo.name=@repository"); params.repository=repository; }
    if (options.state) { conditions.push("f.backlog_state=@state"); params.state=options.state; }

    const rows=this.memoryDb.db.prepare(`
      SELECT f.query_hash, f.signal, f.backlog_state, COUNT(*) reports,
             MAX(f.created_at) last_reported, MIN(f.id) first_id,
             MAX(f.note) note, MAX(f.snapshot_sha) snapshot_sha,
             MAX(e.intent) intent, MAX(e.pack_kind) pack_kind, MAX(e.miss_class) miss_class,
             MAX(e.result_count) result_count, MAX(e.fallback) fallback,
             MAX(e.query_shape_json) query_shape_json, MAX(e.query_text) query_text
      FROM answer_feedback f
      LEFT JOIN repositories repo ON repo.id=f.repository_id
      LEFT JOIN retrieval_events e ON e.id=f.retrieval_event_id
      WHERE ${conditions.join(" AND ")}
      GROUP BY f.query_hash, f.signal, f.backlog_state
      ORDER BY reports DESC, last_reported DESC
      LIMIT @limit
    `).all(params) as any[];

    return {
      repository:repository ?? "all",
      open:rows.filter((row)=>row.backlog_state==="new"||row.backlog_state==="triaged").length,
      entries:rows.map((row)=>({
        queryHash:row.query_hash,
        signal:row.signal as FeedbackSignal,
        state:row.backlog_state as BacklogState,
        reports:row.reports,
        lastReported:row.last_reported,
        note:row.note ?? null,
        snapshotSha:row.snapshot_sha ?? null,
        retrieval:{intent:row.intent ?? null,packKind:row.pack_kind ?? null,missClass:row.miss_class ?? null,
          resultCount:row.result_count ?? null,fallback:row.fallback ?? null,
          queryShape:row.query_shape_json ? JSON.parse(row.query_shape_json) : null},
        suggestedOwner:suggestedOwner(row.signal as FeedbackSignal,{intent:row.intent,missClass:row.miss_class}),
        draftCase:this.draftCase(row),
      })),
    };
  }

  /** A backlog entry is only useful as a runnable case; this is that case, pre-filled as far as the data allows. */
  private draftCase(row:any):any {
    const signal=row.signal as FeedbackSignal;
    return {
      id:`RCE-FB-${String(row.query_hash).slice(0,8)}`,
      job:row.intent==="explain-flow" ? "flow" : row.intent==="impact" ? "impact"
        : row.intent==="debug" ? "debug" : row.intent==="implementation-plan" ? "implementation" : "lookup",
      strict:signal==="wrong"||signal==="stale",
      question:row.query_text ?? null,
      questionMissing:row.query_text ? undefined : "MEMORY_TELEMETRY_QUERY_TEXT was off; supply the question during triage",
      policy:signal==="source-needed" ? "targeted-source" : "memory-sufficient",
      expectedEvidence:[],
      baselineReadSet:[],
      plan:[{tool:"memory_context",args:{}}],
      openedBy:`feedback:${signal}`,
    };
  }

  /** Move an entry through the backlog. `case-created` requires the case id it produced. */
  updateState(queryHash:string,signal:FeedbackSignal,state:BacklogState,caseId?:string):number {
    if (state==="case-created"&&!caseId) throw new Error("case-created requires the evaluation case id it produced");
    return this.memoryDb.db.prepare(
      "UPDATE answer_feedback SET backlog_state=?, case_id=? WHERE query_hash=? AND signal=?",
    ).run(state,caseId ?? null,queryHash,signal).changes;
  }

  summary(repository?:string):any {
    const filter=repository ? "WHERE repo.name=@repository" : "";
    const rows=this.memoryDb.db.prepare(`
      SELECT f.signal, f.backlog_state, COUNT(*) count
      FROM answer_feedback f LEFT JOIN repositories repo ON repo.id=f.repository_id
      ${filter} GROUP BY f.signal, f.backlog_state
    `).all(repository ? {repository} : {}) as any[];

    const bySignal:Record<string,number>={};
    const byState:Record<string,number>={};
    for (const row of rows) {
      bySignal[row.signal]=(bySignal[row.signal] ?? 0)+row.count;
      byState[row.backlog_state]=(byState[row.backlog_state] ?? 0)+row.count;
    }
    const total=rows.reduce((sum,row)=>sum+row.count,0);
    const actionable=rows.filter((row)=>ACTIONABLE.has(row.signal)).reduce((sum,row)=>sum+row.count,0);
    return {
      repository:repository ?? "all",
      total,
      bySignal,
      byState,
      actionable,
      /** Share of reports that demand an engine change rather than confirming it works. */
      actionableRate:total ? Number((actionable/total).toFixed(4)) : null,
    };
  }
}
