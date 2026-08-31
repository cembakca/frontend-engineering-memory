import type Database from "better-sqlite3";
import type { VectorMatch, VectorSearchOptions, VectorStore } from "./providers.js";

function blob(vector:Float32Array):Buffer {
  return Buffer.from(vector.buffer,vector.byteOffset,vector.byteLength);
}

export class SqliteVecStore implements VectorStore {
  readonly dimension:number;
  readonly tableName:string;
  constructor(private readonly db:Database.Database,dimension:number,options:{tableName?:string;legacyTable?:string|null}={}) {
    this.dimension=dimension;
    this.tableName=options.tableName ?? "memory_vectors_v2";
    if (!/^memory_vectors_[a-z0-9_]+$/.test(this.tableName)) throw new Error(`Unsafe vector table name: ${this.tableName}`);
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableName} USING vec0(
      embedding float[${dimension}],
      repository_id integer partition key,
      memory_type text
    )`);
    const legacyTable=options.legacyTable ?? (this.tableName==="memory_vectors_v2" ? "memory_vectors" : null);
    const legacy=legacyTable ? this.db.prepare("SELECT 1 present FROM sqlite_master WHERE type='table' AND name=?").get(legacyTable) : null;
    if (legacy&&legacyTable!==this.tableName&&/^memory_vectors_[a-z0-9_]+$/.test(legacyTable!)) {
      try {
        this.db.exec(`INSERT OR IGNORE INTO ${this.tableName}(rowid,embedding,repository_id,memory_type)
          SELECT v.rowid,v.embedding,m.repository_id,m.memory_type FROM ${legacyTable} v JOIN memories m ON m.id=v.rowid WHERE m.active=1`);
      } catch {}
    }
    const active=this.db.prepare("SELECT active FROM memories WHERE id=?");
    const vectorIds=this.db.prepare(`SELECT rowid id FROM ${this.tableName}`).all() as Array<{id:number|bigint}>;
    for (const row of vectorIds) {
      const memory=active.get(row.id) as {active:number}|undefined;
      if (!memory?.active) this.delete(Number(row.id));
    }
  }

  set(memoryId:number,vector:Float32Array,metadata:{repositoryId:number;memoryType:string}):void {
    if (vector.length!==this.dimension) throw new Error(`Expected ${this.dimension}-dim vector, received ${vector.length}`);
    this.delete(memoryId);
    this.db.prepare(`INSERT INTO ${this.tableName}(rowid,embedding,repository_id,memory_type) VALUES(?,?,?,?)`)
      .run(BigInt(memoryId),blob(vector),BigInt(metadata.repositoryId),metadata.memoryType);
  }

  delete(memoryId:number):void { this.db.prepare(`DELETE FROM ${this.tableName} WHERE rowid=?`).run(BigInt(memoryId)); }
  has(memoryId:number):boolean { return Boolean(this.db.prepare(`SELECT 1 found FROM ${this.tableName} WHERE rowid=?`).get(BigInt(memoryId))); }
  count(options:Omit<VectorSearchOptions,"limit">={}):number {
    const filters:string[]=[]; const values:unknown[]=[];
    if (options.repositoryId!=null) { filters.push("repository_id=?"); values.push(BigInt(options.repositoryId)); }
    if (options.memoryTypes?.length) { filters.push(`memory_type IN (${options.memoryTypes.map(()=>"?").join(",")})`); values.push(...options.memoryTypes); }
    return (this.db.prepare(`SELECT count(*) count FROM ${this.tableName} ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}`).get(...values) as {count:number}).count;
  }

  search(vector:Float32Array,options:VectorSearchOptions):VectorMatch[] {
    const filters:string[]=[];
    const values:unknown[]=[blob(vector),Math.max(options.limit,1)];
    if (options.repositoryId!=null) { filters.push("repository_id=?"); values.push(BigInt(options.repositoryId)); }
    if (options.memoryTypes?.length) {
      filters.push(`memory_type IN (${options.memoryTypes.map(()=>"?").join(",")})`);
      values.push(...options.memoryTypes);
    }
    return this.db.prepare(`SELECT rowid id,distance FROM ${this.tableName} WHERE embedding MATCH ? AND k=? ${filters.length ? `AND ${filters.join(" AND ")}` : ""} ORDER BY distance`)
      .all(...values) as VectorMatch[];
  }
}
