import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { dbPath, embeddingsEnabled } from "../config.js";
import { SCHEMA_SQL } from "./schema.js";
import type { VectorStore } from "./providers.js";
import { SqliteVecStore } from "./vector-store.js";

export class MemoryDatabase {
  readonly db: Database.Database;
  readonly vectorEnabled: boolean;
  readonly vectorDimension = 384;
  readonly vectorStore:VectorStore|null;

  constructor(file = dbPath()) {
    mkdirSync(path.dirname(file), { recursive: true });
    const nativeBinding = process.env.MEMORY_SQLITE_NATIVE_BINDING;
    this.db = new Database(file,nativeBinding ? { nativeBinding } : undefined);
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
    this.applyMigrations();

    let vectorEnabled = false;
    let vectorStore:VectorStore|null=null;
    if (embeddingsEnabled()) {
      try {
        const vectorExtension = process.env.MEMORY_SQLITE_VEC_EXTENSION;
        if (vectorExtension) this.db.loadExtension(vectorExtension);
        else sqliteVec.load(this.db);
        vectorStore=new SqliteVecStore(this.db,this.vectorDimension);
        vectorEnabled = true;
      } catch (error) {
        console.warn(`[memory] sqlite-vec unavailable; semantic vector search disabled: ${(error as Error).message}`);
      }
    }
    this.vectorEnabled = vectorEnabled;
    this.vectorStore=vectorStore;
  }

  private applyMigrations(): void {
    const memoryColumns = this.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    if (!memoryColumns.some((column) => column.name === "removed_sha")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN removed_sha TEXT");
    }
    if (!memoryColumns.some((column)=>column.name==="producer")) this.db.exec("ALTER TABLE memories ADD COLUMN producer TEXT NOT NULL DEFAULT 'deterministic'");
    if (!memoryColumns.some((column)=>column.name==="quality_score")) this.db.exec("ALTER TABLE memories ADD COLUMN quality_score REAL");

    const runColumns=this.db.prepare("PRAGMA table_info(index_runs)").all() as Array<{name:string}>;
    if (!runColumns.some((column)=>column.name==="run_reason")) this.db.exec("ALTER TABLE index_runs ADD COLUMN run_reason TEXT NOT NULL DEFAULT 'INDEXING'");

    const evidenceColumns=this.db.prepare("PRAGMA table_info(memory_evidence)").all() as Array<{name:string}>;
    if (!evidenceColumns.some((column)=>column.name==="commit_sha")) this.db.exec("ALTER TABLE memory_evidence ADD COLUMN commit_sha TEXT");

    const routeColumns = this.db.prepare("PRAGMA table_info(routes)").all() as Array<{ name: string }>;
    const routeMigrations: Array<[string,string]> = [
      ["behavior_files_json","TEXT NOT NULL DEFAULT '[]'"],
      ["server_component","INTEGER"],
      ["client_boundaries_json","TEXT NOT NULL DEFAULT '[]'"],
      ["data_sources_json","TEXT NOT NULL DEFAULT '[]'"],
      ["backend_dependencies_json","TEXT NOT NULL DEFAULT '[]'"],
      ["cache_behavior_json","TEXT NOT NULL DEFAULT '[]'"],
      ["seo_type","TEXT NOT NULL DEFAULT 'unknown'"],
      ["metadata_source","TEXT"],
      ["middleware_matchers_json","TEXT NOT NULL DEFAULT '[]'"],
      ["segment_config_json","TEXT NOT NULL DEFAULT '{}'"],
      ["control_flow_json","TEXT NOT NULL DEFAULT '[]'"],
      ["rendering_basis","TEXT NOT NULL DEFAULT 'observed'"],
    ];
    for (const [name,declaration] of routeMigrations) {
      if (!routeColumns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE routes ADD COLUMN ${name} ${declaration}`);
    }

    const dependencyColumns=this.db.prepare("PRAGMA table_info(dependencies)").all() as Array<{name:string}>;
    if (!dependencyColumns.some((column)=>column.name==="source_symbol")) this.db.exec("ALTER TABLE dependencies ADD COLUMN source_symbol TEXT");
    if (!dependencyColumns.some((column)=>column.name==="start_line")) this.db.exec("ALTER TABLE dependencies ADD COLUMN start_line INTEGER");
  }

  close(): void { this.db.close(); }
}
