import { createHash } from "node:crypto";
import type { MemoryDatabase } from "../memory/database.js";

/**
 * RCE-024 retrieval telemetry.
 *
 * The recorder accepts a closed, typed event and writes only the fields listed
 * here. That is deliberate: a whitelist cannot leak a field somebody adds to a
 * context pack later, whereas a redaction blacklist eventually would.
 *
 * Never recorded: fact content, evidence excerpts, source code, configuration
 * values, `.env` contents. Entity names (`GATEWAY_URL`, `/api/...`, file paths)
 * are recorded because they are repository identifiers that already live in the
 * index — a key name is not a secret, a key value is, and values are never
 * stored anywhere in this system.
 */
export type RetrievalFallback="none"|"targeted-source"|"abstain";

export interface RetrievalEventInput {
  repository:string|null;
  tool:string;
  intent?:string|null;
  packKind?:string|null;
  snapshotSha?:string|null;
  /** Used to derive shape and hash. Stored verbatim only when explicitly enabled. */
  query?:string|null;
  channels?:string[];
  secondRound?:boolean;
  resultIds?:string[];
  resultCount?:number;
  payloadChars?:number;
  estimatedTokens?:number;
  latencyMs?:number;
  fallback?:RetrievalFallback;
  missClass?:string|null;
  gaps?:string[];
  error?:string|null;
}

export interface QueryShape {
  words:number;
  lengthBucket:"xs"|"s"|"m"|"l";
  turkish:boolean;
  hasRoutePath:boolean;
  hasFilePath:boolean;
  hasConfigKey:boolean;
}

/** Telemetry accepts whatever the caller hands over and normalizes it; a shape surprise must not lose the event. */
function toStringArray(value:unknown):string[] {
  if (Array.isArray(value)) return value.map((item)=>typeof item==="string" ? item : JSON.stringify(item)).filter(Boolean);
  if (typeof value==="string") return [value];
  return [];
}

const MAX_RESULT_IDS=25;
const MAX_GAPS=10;

function enabled():boolean { return (process.env.MEMORY_TELEMETRY_ENABLED ?? "1")!=="0"; }
function storeQueryText():boolean { return (process.env.MEMORY_TELEMETRY_QUERY_TEXT ?? "0")==="1"; }
function retention():number {
  const parsed=Number(process.env.MEMORY_TELEMETRY_RETENTION ?? "5000");
  return Number.isFinite(parsed)&&parsed>0 ? Math.floor(parsed) : 5000;
}

export function queryShape(query:string):QueryShape {
  const words=(query.match(/\S+/g) ?? []).length;
  return {
    words,
    lengthBucket:query.length<40 ? "xs" : query.length<120 ? "s" : query.length<400 ? "m" : "l",
    turkish:/[çğıöşüÇĞİÖŞÜ]/.test(query),
    hasRoutePath:/(^|\s)\/[\w[\]/-]*/.test(query),
    hasFilePath:/[\w/-]+\.(?:tsx?|jsx?|json|mjs|cjs)\b/.test(query),
    hasConfigKey:/\b[A-Z][A-Z0-9_]{3,}\b/.test(query),
  };
}

/** Grouping key for repeated questions. The DB owner is the person who asked; this only avoids storing prose by default. */
export function queryHash(query:string):string {
  return createHash("sha256").update(query.trim().toLocaleLowerCase("tr-TR")).digest("hex").slice(0,32);
}

/**
 * Best-effort miss classification using the RCE-003 taxonomy. Only the cases
 * the engine can tell apart on its own are assigned; the rest stay null rather
 * than guessing.
 */
export function deriveMissClass(input:RetrievalEventInput):string|null {
  if (input.error) return "engine-error";
  const gaps=toStringArray(input.gaps).join(" ").toLowerCase();
  if (gaps.includes("seed could not be resolved")) return "wrong-intent";
  if (gaps.includes("semantic graph unavailable")) return "engine-error";
  if ((input.resultCount ?? 0)===0) return "missing-fact";
  if (input.fallback==="targeted-source") return "missing-evidence";
  return null;
}

export class RetrievalTelemetry {
  private inserts=0;
  constructor(private readonly memoryDb:MemoryDatabase) {}

  /** Never throws: a telemetry failure must not break a retrieval answer. Returns the event id when one was written. */
  record(input:RetrievalEventInput):number|null {
    if (!enabled()) return null;
    try { return this.write(input); } catch (error) {
      console.warn(`[telemetry] retrieval event not recorded: ${(error as Error).message}`);
      return null;
    }
  }

  private write(input:RetrievalEventInput):number {
    const repositoryId=input.repository
      ? (this.memoryDb.db.prepare("SELECT id FROM repositories WHERE name=?").get(input.repository) as {id:number}|undefined)?.id ?? null
      : null;
    const query=input.query ?? "";
    const missClass=input.missClass ?? deriveMissClass(input);

    const result=this.memoryDb.db.prepare(`
      INSERT INTO retrieval_events(
        repository_id,tool,intent,pack_kind,snapshot_sha,query_hash,query_shape_json,query_text,
        channels_json,second_round,result_ids_json,result_count,payload_chars,estimated_tokens,
        latency_ms,fallback,miss_class,gaps_json,error)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      repositoryId,
      input.tool,
      input.intent ?? null,
      input.packKind ?? null,
      input.snapshotSha ?? null,
      queryHash(query),
      JSON.stringify(queryShape(query)),
      storeQueryText() ? query : null,
      JSON.stringify(toStringArray(input.channels)),
      input.secondRound ? 1 : 0,
      JSON.stringify(toStringArray(input.resultIds).slice(0,MAX_RESULT_IDS)),
      input.resultCount ?? 0,
      input.payloadChars ?? 0,
      input.estimatedTokens ?? 0,
      Math.max(0,Math.round(input.latencyMs ?? 0)),
      input.fallback ?? "none",
      missClass,
      JSON.stringify(toStringArray(input.gaps).slice(0,MAX_GAPS)),
      input.error ?? null,
    );

    this.inserts+=1;
    if (this.inserts%100===0) this.prune();
    return Number(result.lastInsertRowid);
  }

  /** Keep the newest events only; telemetry must not grow without bound. */
  prune(limit=retention()):number {
    const result=this.memoryDb.db.prepare(`
      DELETE FROM retrieval_events WHERE id NOT IN (
        SELECT id FROM retrieval_events ORDER BY id DESC LIMIT ?
      )
    `).run(limit);
    return result.changes;
  }

  report(repository?:string,limit=200):any {
    const filter=repository ? "WHERE repo.name=@repository" : "";
    const params:Record<string,unknown>=repository ? {repository,limit} : {limit};
    const rows=this.memoryDb.db.prepare(`
      SELECT e.tool,e.intent,e.pack_kind,e.miss_class,e.fallback,e.latency_ms,e.estimated_tokens,
             e.payload_chars,e.result_count,e.second_round,e.created_at
      FROM retrieval_events e LEFT JOIN repositories repo ON repo.id=e.repository_id
      ${filter} ORDER BY e.id DESC LIMIT @limit
    `).all(params) as any[];

    const tally=(key:string)=>rows.reduce((counts:Record<string,number>,row)=>{
      const value=String(row[key] ?? "none");
      counts[value]=(counts[value] ?? 0)+1;
      return counts;
    },{});
    const percentile=(values:number[],fraction:number)=>{
      if (!values.length) return null;
      const sorted=[...values].sort((a,b)=>a-b);
      return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*fraction))] ?? null;
    };
    const latencies=rows.map((row)=>Number(row.latency_ms));
    const tokens=rows.map((row)=>Number(row.estimated_tokens));

    return {
      repository:repository ?? "all",
      events:rows.length,
      byTool:tally("tool"),
      byIntent:tally("intent"),
      byPackKind:tally("pack_kind"),
      byMissClass:tally("miss_class"),
      byFallback:tally("fallback"),
      secondRoundRate:rows.length ? Number((rows.filter((row)=>row.second_round).length/rows.length).toFixed(4)) : null,
      missRate:rows.length ? Number((rows.filter((row)=>row.miss_class).length/rows.length).toFixed(4)) : null,
      latencyMs:{p50:percentile(latencies,0.5),p95:percentile(latencies,0.95)},
      estimatedTokens:{p50:percentile(tokens,0.5),p95:percentile(tokens,0.95)},
    };
  }

  recent(repository?:string,limit=20):any[] {
    const filter=repository ? "WHERE repo.name=@repository" : "";
    return this.memoryDb.db.prepare(`
      SELECT e.created_at,e.tool,e.intent,e.pack_kind,e.result_count,e.estimated_tokens,e.latency_ms,
             e.fallback,e.miss_class,e.query_shape_json,e.gaps_json
      FROM retrieval_events e LEFT JOIN repositories repo ON repo.id=e.repository_id
      ${filter} ORDER BY e.id DESC LIMIT @limit
    `).all(repository ? {repository,limit} : {limit}) as any[];
  }
}
