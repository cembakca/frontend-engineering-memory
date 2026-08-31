import { embeddingsEnabled } from "../config.js";
import type { MemoryDatabase } from "../memory/database.js";
import type { MemoryType, RetrievalQuery, SearchResult } from "../types.js";
import { understandQuery } from "./understand.js";

function ftsQuery(input: string): string | null {
  const terms = input.match(/[\p{L}\p{N}_@./:-]+/gu)?.filter((term) => term.length >= 2).slice(0,12) ?? [];
  return terms.length ? terms.map((term) => `"${term.replaceAll('"','""')}"`).join(" OR ") : null;
}

function add(combined:Map<number,SearchResult>,result:SearchResult,channelScore:number):void {
  const existing=combined.get(result.id);
  if (existing) {
    existing.score+=channelScore;
    if (!existing.channels.includes(result.channels[0]!)) existing.channels.push(...result.channels);
  } else combined.set(result.id,{...result,score:channelScore});
}

function sqlResults(memoryDb:MemoryDatabase,query:RetrievalQuery,limit:number):SearchResult[] {
  const out:SearchResult[]=[];
  if (query.nextMajor!=null) {
    const rows=memoryDb.db.prepare(`
      SELECT m.id,repo.name repository,m.memory_type type,m.subject,m.content,e.file_path source_file,m.updated_sha commit_sha
      FROM repositories repo JOIN memories m ON m.repository_id=repo.id
      LEFT JOIN memory_evidence e ON e.memory_id=m.id
      WHERE m.active=1 AND m.memory_type='repository_profile' AND repo.next_version LIKE ? ${query.repository ? "AND repo.name=?" : ""}
      GROUP BY m.id ORDER BY repo.name LIMIT ?
    `).all(...(query.repository ? [`${query.nextMajor}%`,query.repository,limit] : [`${query.nextMajor}%`,limit])) as any[];
    out.push(...rows.map(({source_file,commit_sha,...row},index)=>({...row,sourceFile:source_file,commitSha:commit_sha,score:2-index/100,channels:["sql"]})));
  }
  if (query.route || /\broutes?\b/i.test(query.raw)) {
    const rows=memoryDb.db.prepare(`
      SELECT r.id,repo.name repository,r.route,r.router_type,r.route_type,r.rendering_mode,r.source_file,
             r.last_seen_sha,r.backend_dependencies_json,r.cache_behavior_json
      FROM routes r JOIN repositories repo ON repo.id=r.repository_id
      WHERE r.active=1 ${query.repository ? "AND repo.name=?" : ""} ${query.route ? "AND r.route=?" : ""}
      ORDER BY repo.name,r.route LIMIT ?
    `).all(...[...(query.repository ? [query.repository] : []),...(query.route ? [query.route] : []),limit]) as any[];
    out.push(...rows.map((row,index)=>({
      id:-Number(row.id),repository:row.repository,type:"rendering" as const,subject:`route:${row.route}`,
      content:`Route ${row.route} uses ${row.router_type} router (${row.route_type}), renders as ${row.rendering_mode}; backend dependencies=${row.backend_dependencies_json}; cache=${row.cache_behavior_json}.`,
      sourceFile:row.source_file,commitSha:row.last_seen_sha,score:2-index/100,channels:["sql"],
    })));
  }
  return out;
}

export async function hybridSearch(memoryDb: MemoryDatabase, rawQuery: string, options: { repo?: string; limit?: number; memoryTypes?:MemoryType[] } = {}): Promise<SearchResult[]> {
  const limit=Math.max(1,Math.min(50,options.limit ?? 10));
  const query=understandQuery(rawQuery,options);
  const combined=new Map<number,SearchResult>();
  if (query.channels.includes("sql")) for (const result of sqlResults(memoryDb,query,limit*2)) add(combined,result,2);

  const fts=ftsQuery(rawQuery);
  if (fts && query.channels.includes("fts")) {
    const typeFilter=query.memoryTypes?.length ? `AND m.memory_type IN (${query.memoryTypes.map(()=>"?").join(",")})` : "";
    const params:unknown[]=[fts];
    if (query.repository) params.push(query.repository);
    if (query.memoryTypes?.length) params.push(...query.memoryTypes);
    params.push(limit*3);
    const rows=memoryDb.db.prepare(`
      SELECT m.id,repo.name repository,m.memory_type type,m.subject,m.content,
             (SELECT MIN(e.file_path) FROM memory_evidence e WHERE e.memory_id=m.id) source_file,
             m.updated_sha commit_sha,bm25(memory_fts) rank
      FROM memory_fts JOIN memories m ON m.id=memory_fts.memory_id
      JOIN repositories repo ON repo.id=m.repository_id
      WHERE memory_fts MATCH ? AND m.active=1 ${query.repository ? "AND repo.name=?" : ""} ${typeFilter}
      ORDER BY rank LIMIT ?
    `).all(...params) as any[];
    rows.forEach((row,index)=>add(combined,{id:row.id,repository:row.repository,type:row.type,subject:row.subject,content:row.content,sourceFile:row.source_file,commitSha:row.commit_sha,score:0,channels:["fts"]},1/(1+index)));
  }

  if (memoryDb.vectorStore && embeddingsEnabled() && query.channels.includes("vector")) {
    try {
      const { embeddingProvider }=await import("../memory/embeddings.js");
      const vector=await embeddingProvider().embedQuery(rawQuery);
      const repositoryId=query.repository ? (memoryDb.db.prepare("SELECT id FROM repositories WHERE name=?").get(query.repository) as {id:number}|undefined)?.id : undefined;
      if (!query.repository || repositoryId!=null) {
        const matches=memoryDb.vectorStore.search(vector,{repositoryId,memoryTypes:query.memoryTypes,limit:limit*3});
        if (matches.length) {
          const placeholders=matches.map(()=>"?").join(",");
          const rows=memoryDb.db.prepare(`SELECT m.id,repo.name repository,m.memory_type type,m.subject,m.content,MIN(e.file_path) source_file,m.updated_sha commit_sha FROM memories m JOIN repositories repo ON repo.id=m.repository_id LEFT JOIN memory_evidence e ON e.memory_id=m.id WHERE m.id IN (${placeholders}) AND m.active=1 GROUP BY m.id`).all(...matches.map((match)=>match.id)) as any[];
          const byId=new Map(rows.map((row)=>[Number(row.id),row]));
          for (const match of matches) {
            const row=byId.get(match.id); if (!row) continue;
            add(combined,{id:row.id,repository:row.repository,type:row.type,subject:row.subject,content:row.content,sourceFile:row.source_file,commitSha:row.commit_sha,score:0,channels:["vector"]},1/(1+match.distance));
          }
        }
      }
    } catch (error) { console.warn(`[search] vector channel failed, returning SQL/FTS results: ${(error as Error).message}`); }
  }
  return [...combined.values()].sort((a,b)=>b.score-a.score).slice(0,limit);
}
