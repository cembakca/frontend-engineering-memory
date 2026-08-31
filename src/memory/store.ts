import path from "node:path";
import { readTextIfSmall, sha256 } from "../utils/fs.js";
import type { DependencyCandidate, MemoryCandidate, PreparedMemoryCandidate, RepositoryConfig, RepositoryProfile, RouteRecord } from "../types.js";
import type { MemoryDatabase } from "./database.js";

export class MemoryStore {
  constructor(private readonly memoryDb: MemoryDatabase) {}
  get db() { return this.memoryDb.db; }
  get vectorEnabled() { return this.memoryDb.vectorEnabled; }

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  upsertRepository(config: RepositoryConfig, profile: RepositoryProfile): number {
    this.db.prepare(`
      INSERT INTO repositories(name,path,main_branch,framework,next_version,react_version,node_version,router_type,package_manager,build_command,start_command,dev_command,output_mode,updated_at)
      VALUES(@name,@path,@mainBranch,@framework,@nextVersion,@reactVersion,@nodeVersion,@routerType,@packageManager,@buildCommand,@startCommand,@devCommand,@outputMode,CURRENT_TIMESTAMP)
      ON CONFLICT(name) DO UPDATE SET
        path=excluded.path, main_branch=excluded.main_branch, framework=excluded.framework,
        next_version=excluded.next_version, react_version=excluded.react_version,
        node_version=excluded.node_version, router_type=excluded.router_type,
        package_manager=excluded.package_manager, build_command=excluded.build_command,
        start_command=excluded.start_command, dev_command=excluded.dev_command,
        output_mode=excluded.output_mode, updated_at=CURRENT_TIMESTAMP
    `).run({
      name: config.name, path: config.path, mainBranch: config.mainBranch ?? "main",
      framework: profile.framework, nextVersion: profile.nextVersion, reactVersion: profile.reactVersion,
      nodeVersion: profile.nodeVersion, routerType: profile.routerType, packageManager: profile.packageManager,
      buildCommand: profile.buildCommand, startCommand: profile.startCommand, devCommand: profile.devCommand,
      outputMode: profile.outputMode,
    });
    const row = this.db.prepare("SELECT id FROM repositories WHERE name=?").get(config.name) as { id: number };
    return row.id;
  }

  getRepository(name: string): any {
    return this.db.prepare("SELECT * FROM repositories WHERE name=?").get(name);
  }

  listRepositories(): any[] {
    return this.db.prepare("SELECT * FROM repositories ORDER BY name").all();
  }

  beginRun(repositoryId: number, type: "FULL" | "INCREMENTAL", fromSha: string | null, toSha: string,reason="INDEXING"): number {
    const result = this.db.prepare("INSERT INTO index_runs(repository_id,type,from_sha,to_sha,run_reason) VALUES(?,?,?,?,?)")
      .run(repositoryId, type, fromSha, toSha,reason);
    return Number(result.lastInsertRowid);
  }

  finishRun(runId: number, fields: { changedFiles: number; memoriesCreated: number; memoriesDeleted: number; status?: string; error?: string | null }): void {
    this.db.prepare(`UPDATE index_runs SET completed_at=CURRENT_TIMESTAMP,changed_files=?,memories_created=?,memories_deleted=?,status=?,error=? WHERE id=?`)
      .run(fields.changedFiles, fields.memoriesCreated, fields.memoriesDeleted, fields.status ?? "SUCCESS", fields.error ?? null, runId);
  }

  private recordRunChange(runId:number|undefined,entityId:number,operation:"CREATE"|"DEACTIVATE"|"REUSE",previousHash:string|null,newHash:string|null,sourceFile:string|null):void {
    if (!runId) return;
    this.db.prepare(`INSERT INTO index_run_changes(run_id,entity_type,entity_id,operation,previous_hash,new_hash,source_file) VALUES(?,'memory',?,?,?,?,?)`)
      .run(runId,entityId,operation,previousHash,newHash,sourceFile);
  }

  listMemoryChanges(repositoryName:string,sinceSha?:string):any[] {
    return this.db.prepare(`
      SELECT ir.id run_id,ir.from_sha,ir.to_sha,ir.type run_type,irc.operation,irc.entity_id memory_id,
             irc.previous_hash,irc.new_hash,irc.source_file,m.memory_type,m.subject,m.content
      FROM index_run_changes irc
      JOIN index_runs ir ON ir.id=irc.run_id
      JOIN repositories repo ON repo.id=ir.repository_id
      LEFT JOIN memories m ON m.id=irc.entity_id
      WHERE repo.name=? AND ir.status='SUCCESS' AND irc.operation!='REUSE'
        ${sinceSha ? `AND ir.id > COALESCE((
          SELECT MAX(previous.id) FROM index_runs previous
          WHERE previous.repository_id=repo.id AND previous.to_sha=? AND previous.status='SUCCESS'
        ),0)` : ""}
      ORDER BY ir.id DESC,irc.id
    `).all(...(sinceSha ? [repositoryName,sinceSha] : [repositoryName]));
  }

  setLastIndexed(repositoryId: number, sha: string): void {
    this.db.prepare("UPDATE repositories SET last_indexed_sha=?, last_indexed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(sha, repositoryId);
  }

  reconcileRoutes(repositoryId: number, routes: RouteRecord[], sha: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE routes SET active=0, removed_sha=? WHERE repository_id=? AND active=1").run(sha, repositoryId);
      const upsert = this.db.prepare(`
        INSERT INTO routes(repository_id,route,route_type,router_type,source_file,layout_chain_json,rendering_mode,dynamic_route,route_params_json,auth_required,middleware_matched,metadata_mode,evidence_json,behavior_files_json,server_component,client_boundaries_json,data_sources_json,backend_dependencies_json,cache_behavior_json,seo_type,metadata_source,middleware_matchers_json,created_sha,last_seen_sha,removed_sha,active)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,1)
        ON CONFLICT(repository_id,route,source_file) DO UPDATE SET
          route_type=excluded.route_type,router_type=excluded.router_type,layout_chain_json=excluded.layout_chain_json,rendering_mode=excluded.rendering_mode,
          dynamic_route=excluded.dynamic_route,route_params_json=excluded.route_params_json,
          auth_required=excluded.auth_required,middleware_matched=excluded.middleware_matched,
          metadata_mode=excluded.metadata_mode,evidence_json=excluded.evidence_json,behavior_files_json=excluded.behavior_files_json,
          server_component=excluded.server_component,client_boundaries_json=excluded.client_boundaries_json,
          data_sources_json=excluded.data_sources_json,backend_dependencies_json=excluded.backend_dependencies_json,
          cache_behavior_json=excluded.cache_behavior_json,seo_type=excluded.seo_type,metadata_source=excluded.metadata_source,
          middleware_matchers_json=excluded.middleware_matchers_json,
          last_seen_sha=excluded.last_seen_sha,removed_sha=NULL,active=1
      `);
      for (const route of routes) {
        upsert.run(repositoryId, route.route, route.routeType, route.routerType, route.sourceFile, JSON.stringify(route.layoutChain), route.renderingMode,
          route.dynamicRoute ? 1 : 0, JSON.stringify(route.routeParams), route.authRequired == null ? null : Number(route.authRequired),
          route.middlewareMatched == null ? null : Number(route.middlewareMatched), route.metadataMode, JSON.stringify(route.evidence),
          JSON.stringify(route.behaviorFiles),route.serverComponent==null ? null : Number(route.serverComponent),JSON.stringify(route.clientBoundaries),
          JSON.stringify(route.dataSources),JSON.stringify(route.backendDependencies),JSON.stringify(route.cacheBehavior),route.seoType,route.metadataSource,
          JSON.stringify(route.middlewareMatchers),sha,sha);
      }
    });
    tx();
  }

  listRoutes(repositoryName: string): any[] {
    return this.db.prepare(`SELECT r.* FROM routes r JOIN repositories repo ON repo.id=r.repository_id WHERE repo.name=? AND r.active=1 ORDER BY r.route,r.source_file`).all(repositoryName);
  }

  getRoute(repositoryName:string,route:string):any | undefined {
    return this.db.prepare(`
      SELECT r.* FROM routes r JOIN repositories repo ON repo.id=r.repository_id
      WHERE repo.name=? AND r.route=? AND r.active=1 ORDER BY r.id LIMIT 1
    `).get(repositoryName,route);
  }

  memoryEvidence(memoryIds:number[]):Map<number,any[]> {
    const grouped=new Map<number,any[]>();
    if (!memoryIds.length) return grouped;
    const placeholders=memoryIds.map(()=>"?").join(",");
    const rows=this.db.prepare(`
      SELECT memory_id,file_path,symbol,start_line,end_line,file_hash,commit_sha
      FROM memory_evidence WHERE memory_id IN (${placeholders})
      ORDER BY memory_id,id
    `).all(...memoryIds) as Array<{memory_id:number}>;
    for (const row of rows) grouped.set(row.memory_id,[...(grouped.get(row.memory_id) ?? []),row]);
    return grouped;
  }

  qualityReport(repositoryName?:string):any {
    const filter=repositoryName ? "AND repo.name=@repository" : "";
    const params=repositoryName ? {repository:repositoryName} : {};
    const memory=this.db.prepare(`
      SELECT COUNT(*) active_memories,
        SUM(CASE WHEN EXISTS(SELECT 1 FROM memory_evidence e WHERE e.memory_id=m.id) THEN 1 ELSE 0 END) with_evidence,
        SUM(CASE WHEN EXISTS(SELECT 1 FROM memory_evidence e WHERE e.memory_id=m.id AND e.commit_sha IS NOT NULL) THEN 1 ELSE 0 END) with_commit,
        SUM(CASE WHEN EXISTS(SELECT 1 FROM memory_evidence e WHERE e.memory_id=m.id AND e.start_line IS NOT NULL) THEN 1 ELSE 0 END) with_line,
        SUM(CASE WHEN EXISTS(SELECT 1 FROM memory_evidence e WHERE e.memory_id=m.id AND e.symbol IS NOT NULL) THEN 1 ELSE 0 END) with_symbol,
        SUM(CASE WHEN m.confidence='inferred' THEN 1 ELSE 0 END) inferred
      FROM memories m JOIN repositories repo ON repo.id=m.repository_id
      WHERE m.active=1 ${filter}
    `).get(params) as Record<string,number|null>;
    const repositories=this.db.prepare(`SELECT COUNT(*) count FROM repositories repo WHERE 1=1 ${filter}`).get(params) as {count:number};
    const routes=this.db.prepare(`SELECT COUNT(*) count FROM routes r JOIN repositories repo ON repo.id=r.repository_id WHERE r.active=1 ${filter}`).get(params) as {count:number};
    const dependencies=this.db.prepare(`SELECT COUNT(*) count FROM dependencies d JOIN repositories repo ON repo.id=d.repository_id WHERE d.active=1 ${filter}`).get(params) as {count:number};
    const routeDependencies=this.db.prepare(`SELECT COUNT(*) count FROM route_dependencies rd JOIN routes r ON r.id=rd.route_id JOIN repositories repo ON repo.id=r.repository_id WHERE r.active=1 ${filter}`).get(params) as {count:number};
    const total=memory.active_memories ?? 0;
    const repositoryId=repositoryName ? (this.db.prepare("SELECT id FROM repositories WHERE name=?").get(repositoryName) as {id:number}|undefined)?.id : undefined;
    const vectorCount=this.memoryDb.vectorStore?.count({repositoryId}) ?? null;
    const ratio=(value:number|null|undefined)=>total ? Number(((value ?? 0)/total).toFixed(4)) : 1;
    return {
      repository:repositoryName ?? "all",
      repositories:repositories.count,
      activeMemories:total,
      routes:routes.count,
      dependencies:dependencies.count,
      routeDependencies:routeDependencies.count,
      evidenceCoverage:ratio(memory.with_evidence),
      commitCoverage:ratio(memory.with_commit),
      lineCoverage:ratio(memory.with_line),
      symbolCoverage:ratio(memory.with_symbol),
      inferredMemories:memory.inferred ?? 0,
      vectors:vectorCount,
      vectorCoverage:vectorCount==null ? null : ratio(vectorCount),
    };
  }

  listDependencies(repositoryName:string):any[] {
    return this.db.prepare(`
      SELECT d.* FROM dependencies d
      JOIN repositories repo ON repo.id=d.repository_id
      WHERE repo.name=? AND d.active=1
      ORDER BY d.dependency_type,d.name,d.source_file
    `).all(repositoryName);
  }

  listRouteDependencies(repositoryName:string,route?:string):any[] {
    return this.db.prepare(`
      SELECT r.route,r.source_file route_source,d.dependency_type,d.name,d.category,d.runtime,
             rd.usage_type,rd.source_file,rd.source_symbol,rd.start_line,rd.last_seen_sha
      FROM route_dependencies rd
      JOIN routes r ON r.id=rd.route_id
      JOIN dependencies d ON d.id=rd.dependency_id
      JOIN repositories repo ON repo.id=r.repository_id
      WHERE repo.name=? AND r.active=1 AND d.active=1 ${route ? "AND r.route=?" : ""}
      ORDER BY r.route,d.dependency_type,d.name,rd.source_file
    `).all(...(route ? [repositoryName,route] : [repositoryName]));
  }

  replaceDependencies(repositoryId: number, deps: DependencyCandidate[], sha: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE dependencies SET active=0 WHERE repository_id=?").run(repositoryId);
      const upsert = this.db.prepare(`
        INSERT INTO dependencies(repository_id,dependency_type,name,category,purpose,runtime,config_key,source_file,source_symbol,start_line,last_seen_sha,active)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,1)
        ON CONFLICT(repository_id,dependency_type,name,source_file) DO UPDATE SET
          category=excluded.category,purpose=excluded.purpose,runtime=excluded.runtime,
          config_key=excluded.config_key,source_symbol=excluded.source_symbol,start_line=excluded.start_line,last_seen_sha=excluded.last_seen_sha,active=1
      `);
      for (const d of deps) upsert.run(repositoryId,d.dependencyType,d.name,d.category,d.purpose,d.runtime,d.configKey ?? null,d.sourceFile,d.sourceSymbol ?? null,d.startLine ?? null,sha);
    });
    tx();
  }

  replaceRouteDependencies(repositoryId:number,routes:RouteRecord[],sha:string):number {
    this.db.prepare("DELETE FROM route_dependencies WHERE route_id IN (SELECT id FROM routes WHERE repository_id=?)").run(repositoryId);
    const routeId=this.db.prepare("SELECT id FROM routes WHERE repository_id=? AND route=? AND source_file=? AND active=1");
    const exactDependency=this.db.prepare("SELECT id FROM dependencies WHERE repository_id=? AND dependency_type=? AND name=? AND source_file=? AND active=1 LIMIT 1");
    const anyDependency=this.db.prepare("SELECT id FROM dependencies WHERE repository_id=? AND dependency_type=? AND name=? AND active=1 ORDER BY id LIMIT 1");
    const insert=this.db.prepare(`INSERT OR IGNORE INTO route_dependencies(route_id,dependency_id,usage_type,source_file,source_symbol,start_line,last_seen_sha) VALUES(?,?,?,?,?,?,?)`);
    let created=0;
    for (const route of routes) {
      const routeRow=routeId.get(repositoryId,route.route,route.sourceFile) as {id:number}|undefined;
      if (!routeRow) continue;
      for (const dependency of route.dependencies) {
        const dependencyRow=(exactDependency.get(repositoryId,dependency.dependencyType,dependency.name,dependency.sourceFile) ?? anyDependency.get(repositoryId,dependency.dependencyType,dependency.name)) as {id:number}|undefined;
        if (!dependencyRow) continue;
        created+=insert.run(routeRow.id,dependencyRow.id,dependency.usageType,dependency.sourceFile,dependency.sourceSymbol ?? null,dependency.startLine ?? null,sha).changes;
      }
    }
    return created;
  }

  private deactivateMemoryIds(ids:number[],removedSha:string,runId?:number):number {
    if (!ids.length) return 0;
    const row=this.db.prepare("SELECT source_hash FROM memories WHERE id=?") as any;
    const source=this.db.prepare("SELECT file_path FROM memory_evidence WHERE memory_id=? ORDER BY id LIMIT 1") as any;
    if (this.memoryDb.vectorEnabled) {
      for (const id of ids) this.memoryDb.vectorStore?.delete(id);
    }
    for (const id of ids) {
      const memory=row.get(id) as {source_hash:string|null}|undefined;
      const evidence=source.get(id) as {file_path:string}|undefined;
      this.db.prepare("DELETE FROM memory_fts WHERE memory_id=?").run(id);
      this.db.prepare("UPDATE memories SET active=0,removed_sha=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(removedSha,id);
      this.recordRunChange(runId,id,"DEACTIVATE",memory?.source_hash ?? null,null,evidence?.file_path ?? null);
    }
    return ids.length;
  }

  deactivateRepositoryMemories(repositoryId: number, removedSha: string, runId?:number, excludeIds:Set<number>=new Set()): number {
    const ids = (this.db.prepare("SELECT id FROM memories WHERE repository_id=? AND active=1").all(repositoryId) as Array<{id:number}>).map((row)=>row.id).filter((id)=>!excludeIds.has(id));
    return this.deactivateMemoryIds(ids,removedSha,runId);
  }

  memoryIdsForSource(repositoryId: number, sourceFile: string): number[] {
    return (this.db.prepare(`SELECT DISTINCT m.id FROM memories m JOIN memory_evidence e ON e.memory_id=m.id WHERE m.repository_id=? AND m.active=1 AND e.file_path=?`).all(repositoryId, sourceFile) as Array<{id:number}>).map((r) => r.id);
  }

  deactivateMemoriesForSource(repositoryId: number, sourceFile: string, removedSha: string, runId?:number, excludeIds:Set<number>=new Set()): number {
    const ids = this.memoryIdsForSource(repositoryId, sourceFile).filter((id)=>!excludeIds.has(id));
    return this.deactivateMemoryIds(ids,removedSha,runId);
  }

  deactivateRouteMemory(repositoryId: number, route: string, sourceFile: string, removedSha: string, runId?:number, excludeIds:Set<number>=new Set()): number {
    const ids = (this.db.prepare(`
      SELECT DISTINCT m.id
      FROM memories m
      JOIN memory_evidence e ON e.memory_id=m.id
      WHERE m.repository_id=? AND m.active=1 AND m.memory_type='rendering'
        AND m.subject=? AND e.file_path=?
    `).all(repositoryId,`route:${route}`,sourceFile) as Array<{id:number}>).map((row) => row.id);
    return this.deactivateMemoryIds(ids.filter((id)=>!excludeIds.has(id)),removedSha,runId);
  }

  deactivateAiMemoriesForSources(repositoryId:number,sourceFiles:string[],removedSha:string,runId?:number,excludeIds:Set<number>=new Set()):number {
    if (!sourceFiles.length) return 0;
    const placeholders=sourceFiles.map(()=>"?").join(",");
    const ids=(this.db.prepare(`
      SELECT DISTINCT m.id FROM memories m JOIN memory_evidence e ON e.memory_id=m.id
      WHERE m.repository_id=? AND m.active=1 AND m.producer='ai' AND e.file_path IN (${placeholders})
    `).all(repositoryId,...sourceFiles) as Array<{id:number}>).map((row)=>row.id).filter((id)=>!excludeIds.has(id));
    return this.deactivateMemoryIds(ids,removedSha,runId);
  }

  async validActiveAiMemoryIds(repositoryId:number,repoPath:string):Promise<Set<number>> {
    const rows=this.db.prepare(`
      SELECT m.id,e.file_path,e.file_hash FROM memories m JOIN memory_evidence e ON e.memory_id=m.id
      WHERE m.repository_id=? AND m.active=1 AND m.producer='ai' ORDER BY m.id,e.id
    `).all(repositoryId) as Array<{id:number;file_path:string;file_hash:string|null}>;
    const currentHashes=new Map<string,string|null>();
    const validity=new Map<number,boolean>();
    for (const row of rows) {
      if (!currentHashes.has(row.file_path)) {
        const content=await readTextIfSmall(path.join(repoPath,row.file_path));
        currentHashes.set(row.file_path,content==null ? null : sha256(content));
      }
      validity.set(row.id,(validity.get(row.id) ?? true) && row.file_hash!=null && currentHashes.get(row.file_path)===row.file_hash);
    }
    return new Set([...validity].filter(([,valid])=>valid).map(([id])=>id));
  }

  routeKeysAffectedByFiles(repositoryId: number, sourceFiles: Set<string>): Set<string> {
    const rows = this.db.prepare("SELECT route,source_file,behavior_files_json FROM routes WHERE repository_id=? AND active=1")
      .all(repositoryId) as Array<{route:string;source_file:string;behavior_files_json:string}>;
    const keys = new Set<string>();
    for (const row of rows) {
      let behaviorFiles: string[] = [];
      try { behaviorFiles = JSON.parse(row.behavior_files_json) as string[]; } catch {}
      if (behaviorFiles.some((file) => sourceFiles.has(file)) || sourceFiles.has(row.source_file)) {
        keys.add(`${row.route}\0${row.source_file}`);
      }
    }
    return keys;
  }

  async prepareMemories(repoPath: string, candidates: MemoryCandidate[]): Promise<PreparedMemoryCandidate[]> {
    const hashCache = new Map<string,string|null>();
    const rows: PreparedMemoryCandidate[] = [];
    for (const candidate of candidates) {
      if (!hashCache.has(candidate.sourceFile)) {
        const file = await readTextIfSmall(path.join(repoPath,candidate.sourceFile));
        hashCache.set(candidate.sourceFile,file == null ? null : sha256(file));
      }
      const sourceFiles = [...new Set([candidate.sourceFile,...(candidate.additionalEvidenceFiles ?? [])])];
      for (const sourceFile of sourceFiles) {
        if (!hashCache.has(sourceFile)) {
          const file = await readTextIfSmall(path.join(repoPath,sourceFile));
          hashCache.set(sourceFile,file == null ? null : sha256(file));
        }
      }
      const evidence = sourceFiles.map((sourceFile) => ({sourceFile,fileHash:hashCache.get(sourceFile) ?? null}));
      rows.push({
        candidate,
        evidence,
        sourceHash: sha256(`${candidate.producer ?? "deterministic"}|${candidate.type}|${candidate.subject}|${candidate.content}|${evidence.map((item) => `${item.sourceFile}:${item.fileHash ?? ""}`).join("|")}`),
      });
    }
    return rows;
  }

  partitionPreparedMemories(repositoryId:number,rows:PreparedMemoryCandidate[]):{reused:Array<{id:number;row:PreparedMemoryCandidate}>;fresh:PreparedMemoryCandidate[]} {
    const active=this.db.prepare("SELECT id,source_hash FROM memories WHERE repository_id=? AND active=1 ORDER BY id").all(repositoryId) as Array<{id:number;source_hash:string|null}>;
    const byHash=new Map<string,number[]>();
    for (const memory of active) if (memory.source_hash) byHash.set(memory.source_hash,[...(byHash.get(memory.source_hash) ?? []),memory.id]);
    const reused:Array<{id:number;row:PreparedMemoryCandidate}>=[];
    const fresh:PreparedMemoryCandidate[]=[];
    for (const row of rows) {
      const ids=byHash.get(row.sourceHash);
      const id=ids?.shift();
      if (id) reused.push({id,row}); else fresh.push(row);
    }
    return {reused,fresh};
  }

  recordReusedMemories(runId:number,reused:Array<{id:number;row:PreparedMemoryCandidate}>):void {
    for (const item of reused) this.recordRunChange(runId,item.id,"REUSE",item.row.sourceHash,item.row.sourceHash,item.row.candidate.sourceFile);
  }

  insertPreparedMemories(repositoryId: number, rows: PreparedMemoryCandidate[], sha: string, runId?:number): number[] {
    const insertMemory = this.db.prepare(`INSERT INTO memories(repository_id,memory_type,subject,content,confidence,producer,quality_score,source_hash,created_sha,updated_sha) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    const insertEvidence = this.db.prepare(`INSERT INTO memory_evidence(memory_id,file_path,symbol,start_line,end_line,file_hash,commit_sha) VALUES(?,?,?,?,?,?,?)`);
    const insertFts = this.db.prepare(`INSERT INTO memory_fts(memory_id,repository_id,memory_type,subject,content) VALUES(?,?,?,?,?)`);
    const ids: number[] = [];

    for (const { candidate, evidence, sourceHash } of rows) {
        const result = insertMemory.run(repositoryId,candidate.type,candidate.subject,candidate.content,candidate.confidence,candidate.producer ?? "deterministic",candidate.qualityScore ?? null,sourceHash,sha,sha);
        const id = Number(result.lastInsertRowid);
        for (const item of evidence) {
          const primary = item.sourceFile === candidate.sourceFile;
          insertEvidence.run(id,item.sourceFile,primary ? candidate.sourceSymbol ?? null : null,primary ? candidate.startLine ?? null : null,primary ? candidate.endLine ?? null : null,item.fileHash,sha);
        }
        insertFts.run(id,repositoryId,candidate.type,candidate.subject,candidate.content);
        this.recordRunChange(runId,id,"CREATE",null,sourceHash,candidate.sourceFile);
        ids.push(id);
    }
    return ids;
  }

  async insertMemories(repositoryId: number, repoPath: string, candidates: MemoryCandidate[], sha: string): Promise<number[]> {
    const rows = await this.prepareMemories(repoPath,candidates);
    return this.transaction(() => this.insertPreparedMemories(repositoryId,rows,sha));
  }

  setVector(memoryId: number, vector: Float32Array): void {
    if (!this.memoryDb.vectorStore) return;
    const row=this.db.prepare("SELECT repository_id,memory_type FROM memories WHERE id=?").get(memoryId) as {repository_id:number;memory_type:string}|undefined;
    if (!row) throw new Error(`Memory not found for vector: ${memoryId}`);
    this.memoryDb.vectorStore.set(memoryId,vector,{repositoryId:row.repository_id,memoryType:row.memory_type});
  }

  getMemories(ids: number[]): Array<{id:number; content:string}> {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db.prepare(`SELECT id,content FROM memories WHERE id IN (${placeholders}) ORDER BY id`).all(...ids) as Array<{id:number;content:string}>;
  }
}
