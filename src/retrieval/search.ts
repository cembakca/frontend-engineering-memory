import { embeddingsEnabled } from "../config.js";
import type { MemoryDatabase } from "../memory/database.js";
import { routesEquivalent } from "./route-identity.js";
import type { MemoryType, RetrievalQuery, SearchResult } from "../types.js";
import { understandQuery } from "./understand.js";
import { canonicalEntityKey, rankAndDedupe } from "./ranking.js";
import { planQuery } from "./query-plan.js";
import { matchingQueryAliases, normalizeQueryAliases, type QueryAliases } from "./query-vocabulary.js";

function repositoryAliasGroups(memoryDb:MemoryDatabase,repository?:string):QueryAliases[] {
  const rows=memoryDb.db.prepare(`SELECT query_aliases_json FROM repositories ${repository ? "WHERE name=?" : ""}`)
    .all(...(repository ? [repository] : [])) as Array<{query_aliases_json:string|null}>;
  return rows.flatMap((row)=>{
    try { return [normalizeQueryAliases(JSON.parse(row.query_aliases_json ?? "{}"))]; }
    catch { return []; }
  });
}

function ftsQuery(input: string,aliases:QueryAliases[]): string | null {
  const direct=input.match(/[\p{L}\p{N}_@./:-]+/gu)?.filter((term)=>term.length>=2).slice(0,12) ?? [];
  const terms=[...direct,...matchingQueryAliases(input,aliases).slice(0,12)];
  return terms.length ? terms.map((term) => `"${term.replaceAll('"','""')}"`).join(" OR ") : null;
}

function add(combined:Map<number,SearchResult>,result:SearchResult,channelRank:number):void {
  const channel=result.channels[0] as "sql"|"fts"|"vector";
  const existing=combined.get(result.id);
  if (existing) {
    if (!existing.channels.includes(result.channels[0]!)) existing.channels.push(...result.channels);
    existing.channelRanks={...existing.channelRanks,[channel]:Math.min(existing.channelRanks?.[channel] ?? Infinity,channelRank)};
  } else combined.set(result.id,{...result,score:0,channelRanks:{[channel]:channelRank}});
}

function sqlResults(memoryDb:MemoryDatabase,query:RetrievalQuery,limit:number):SearchResult[] {
  const out:SearchResult[]=[];
  if (query.nextMajor!=null) {
    const rows=memoryDb.db.prepare(`
      SELECT m.id,repo.name repository,m.memory_type type,m.subject,m.content,MIN(e.file_path) source_file,
             (SELECT symbol FROM memory_evidence es WHERE es.memory_id=m.id AND es.symbol IS NOT NULL ORDER BY es.id LIMIT 1) source_symbol,
             m.updated_sha commit_sha,
             m.confidence,m.quality_score,repo.last_indexed_sha repository_sha,COUNT(e.id) evidence_count,
             SUM(CASE WHEN e.start_line IS NOT NULL THEN 1 ELSE 0 END) located_evidence_count
      FROM repositories repo JOIN memories m ON m.repository_id=repo.id
      LEFT JOIN memory_evidence e ON e.memory_id=m.id
      WHERE m.active=1 AND m.memory_type='repository_profile' AND repo.next_version LIKE ? ${query.repository ? "AND repo.name=?" : ""}
      GROUP BY m.id ORDER BY repo.name LIMIT ?
    `).all(...(query.repository ? [`${query.nextMajor}%`,query.repository,limit] : [`${query.nextMajor}%`,limit])) as any[];
    out.push(...rows.map((row)=>({id:row.id,repository:row.repository,type:row.type,subject:row.subject,content:row.content,
      sourceFile:row.source_file,sourceSymbol:row.source_symbol,commitSha:row.commit_sha,confidence:row.confidence,qualityScore:row.quality_score,
      repositorySha:row.repository_sha,evidenceCount:row.evidence_count,locatedEvidenceCount:row.located_evidence_count,score:0,channels:["sql"]})));
  }
  if (query.route || (query.intent==="lookup"&&/\broutes?\b/i.test(query.raw))) {
    const rows=memoryDb.db.prepare(`
      SELECT r.id,repo.name repository,r.route,r.router_type,r.route_type,r.rendering_mode,r.source_file,
             r.last_seen_sha,r.backend_dependencies_json,r.cache_behavior_json,repo.last_indexed_sha repository_sha
      FROM routes r JOIN repositories repo ON repo.id=r.repository_id
      WHERE r.active=1 ${query.repository ? "AND repo.name=?" : ""}
      ORDER BY repo.name,r.route LIMIT ?
    `).all(...[...(query.repository ? [query.repository] : []),query.route ? 10000 : limit]) as any[];
    const selected=query.route ? rows.filter((row)=>routesEquivalent(String(row.route),query.route!)).slice(0,limit) : rows;
    out.push(...selected.map((row,index)=>({
      id:-Number(row.id),repository:row.repository,type:"rendering" as const,subject:`route:${row.route}`,
      content:`Route ${row.route} uses ${row.router_type} router (${row.route_type}), renders as ${row.rendering_mode}; backend dependencies=${row.backend_dependencies_json}; cache=${row.cache_behavior_json}.`,
      sourceFile:row.source_file,commitSha:row.last_seen_sha,repositorySha:row.repository_sha,confidence:"verified",
      evidenceCount:1,locatedEvidenceCount:0,relationCoverage:1,score:0,channels:["sql"],
    })));
  }
  return out;
}

export async function hybridSearch(memoryDb: MemoryDatabase, rawQuery: string, options: { repo?: string; limit?: number; memoryTypes?:MemoryType[] } = {}): Promise<SearchResult[]> {
  const limit=Math.max(1,Math.min(50,options.limit ?? 10));
  const query=understandQuery(rawQuery,options);
  const plan=planQuery(rawQuery,{repo:options.repo,memoryTypes:options.memoryTypes});
  const explicitTypes=options.memoryTypes?.length ? new Set(options.memoryTypes) : null;
  const boostedTypes=!explicitTypes&&query.memoryTypes?.length ? new Set(query.memoryTypes) : null;
  const combined=new Map<number,SearchResult>();
  if (query.channels.includes("sql")) sqlResults(memoryDb,query,limit*2).forEach((result,index)=>add(combined,result,index+1));

  const fts=ftsQuery(rawQuery,repositoryAliasGroups(memoryDb,query.repository));
  if (fts && query.channels.includes("fts")) {
    const typeFilter=explicitTypes?.size ? `AND m.memory_type IN (${[...explicitTypes].map(()=>"?").join(",")})` : "";
    const params:unknown[]=[fts];
    if (query.repository) params.push(query.repository);
    if (explicitTypes?.size) params.push(...explicitTypes);
    // Dedupe happens after retrieval. Keep enough pre-rank candidates so a
    // high-duplication entity cannot consume the whole pool with occurrences.
    params.push(Math.min(200,Math.max(50,limit*6)));
    const rows=memoryDb.db.prepare(`
      SELECT m.id,repo.name repository,m.memory_type type,m.subject,m.content,
             (SELECT MIN(e.file_path) FROM memory_evidence e WHERE e.memory_id=m.id) source_file,
             (SELECT symbol FROM memory_evidence es WHERE es.memory_id=m.id AND es.symbol IS NOT NULL ORDER BY es.id LIMIT 1) source_symbol,
             m.updated_sha commit_sha,m.confidence,m.quality_score,repo.last_indexed_sha repository_sha,
             (SELECT COUNT(*) FROM memory_evidence ec WHERE ec.memory_id=m.id) evidence_count,
             (SELECT COUNT(*) FROM memory_evidence el WHERE el.memory_id=m.id AND el.start_line IS NOT NULL) located_evidence_count,
             bm25(memory_fts) rank
      FROM memory_fts JOIN memories m ON m.id=memory_fts.memory_id
      JOIN repositories repo ON repo.id=m.repository_id
      WHERE memory_fts MATCH ? AND m.active=1 ${query.repository ? "AND repo.name=?" : ""} ${typeFilter}
      ORDER BY rank LIMIT ?
    `).all(...params) as any[];
    rows.forEach((row,index)=>add(combined,{id:row.id,repository:row.repository,type:row.type,subject:row.subject,content:row.content,
      sourceFile:row.source_file,sourceSymbol:row.source_symbol,commitSha:row.commit_sha,confidence:row.confidence,qualityScore:row.quality_score,
      repositorySha:row.repository_sha,evidenceCount:row.evidence_count,locatedEvidenceCount:row.located_evidence_count,
      score:0,channels:["fts"]},index+1));
  }

  if (memoryDb.vectorStore && embeddingsEnabled() && query.channels.includes("vector")) {
    try {
      const { embeddingProvider }=await import("../memory/embeddings.js");
      const vector=await embeddingProvider().embedQuery(rawQuery);
      const repositoryId=query.repository ? (memoryDb.db.prepare("SELECT id FROM repositories WHERE name=?").get(query.repository) as {id:number}|undefined)?.id : undefined;
      if (!query.repository || repositoryId!=null) {
        const matches=memoryDb.vectorStore.search(vector,{repositoryId,memoryTypes:explicitTypes ? [...explicitTypes] : undefined,limit:limit*3});
        if (matches.length) {
          const placeholders=matches.map(()=>"?").join(",");
          const rows=memoryDb.db.prepare(`SELECT m.id,repo.name repository,m.memory_type type,m.subject,m.content,MIN(e.file_path) source_file,(SELECT symbol FROM memory_evidence es WHERE es.memory_id=m.id AND es.symbol IS NOT NULL ORDER BY es.id LIMIT 1) source_symbol,m.updated_sha commit_sha,m.confidence,m.quality_score,repo.last_indexed_sha repository_sha,COUNT(e.id) evidence_count,SUM(CASE WHEN e.start_line IS NOT NULL THEN 1 ELSE 0 END) located_evidence_count FROM memories m JOIN repositories repo ON repo.id=m.repository_id LEFT JOIN memory_evidence e ON e.memory_id=m.id WHERE m.id IN (${placeholders}) AND m.active=1 GROUP BY m.id`).all(...matches.map((match)=>match.id)) as any[];
          const byId=new Map(rows.map((row)=>[Number(row.id),row]));
          for (const [index,match] of matches.entries()) {
            const row=byId.get(match.id); if (!row) continue;
            add(combined,{id:row.id,repository:row.repository,type:row.type,subject:row.subject,content:row.content,
              sourceFile:row.source_file,sourceSymbol:row.source_symbol,commitSha:row.commit_sha,confidence:row.confidence,qualityScore:row.quality_score,
              repositorySha:row.repository_sha,evidenceCount:row.evidence_count,locatedEvidenceCount:row.located_evidence_count,
              score:0,channels:["vector"]},index+1);
          }
        }
      }
    } catch (error) { console.warn(`[search] vector channel failed, returning SQL/FTS results: ${(error as Error).message}`); }
  }
  for (const result of combined.values()) {
    if (boostedTypes?.has(result.type)) result.queryTypeBoost=.2;
    const key=canonicalEntityKey(result);
    result.exactAnchorMatch=Boolean(
      (plan.anchors.route&&result.subject.startsWith("route:")&&routesEquivalent(result.subject.slice("route:".length),plan.anchors.route))
      ||plan.anchors.config.some((anchor)=>key.endsWith(`:config:${anchor}`))
      ||plan.anchors.files.some((anchor)=>result.sourceFile===anchor||result.subject.startsWith(anchor))
      ||plan.anchors.symbols.some((anchor)=>result.subject===anchor),
    );
  }
  // Channel ranks are provenance/tie-break evidence; they are never summed.
  // Canonical entity, task fit, relations, freshness and evidence quality own ranking.
  return rankAndDedupe([...combined.values()],query.intent,limit);
}
