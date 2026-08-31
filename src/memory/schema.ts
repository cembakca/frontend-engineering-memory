export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  main_branch TEXT NOT NULL DEFAULT 'main',
  framework TEXT,
  next_version TEXT,
  react_version TEXT,
  node_version TEXT,
  router_type TEXT,
  package_manager TEXT,
  build_command TEXT,
  start_command TEXT,
  dev_command TEXT,
  output_mode TEXT,
  last_indexed_sha TEXT,
  last_indexed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS index_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  from_sha TEXT,
  to_sha TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('FULL','INCREMENTAL')),
  run_reason TEXT NOT NULL DEFAULT 'INDEXING',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  changed_files INTEGER NOT NULL DEFAULT 0,
  memories_created INTEGER NOT NULL DEFAULT 0,
  memories_deleted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  error TEXT
);

CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  route TEXT NOT NULL,
  route_type TEXT NOT NULL,
  router_type TEXT NOT NULL,
  source_file TEXT NOT NULL,
  layout_chain_json TEXT NOT NULL DEFAULT '[]',
  rendering_mode TEXT NOT NULL,
  dynamic_route INTEGER NOT NULL DEFAULT 0,
  route_params_json TEXT NOT NULL DEFAULT '[]',
  auth_required INTEGER,
  middleware_matched INTEGER,
  metadata_mode TEXT NOT NULL DEFAULT 'unknown',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  behavior_files_json TEXT NOT NULL DEFAULT '[]',
  server_component INTEGER,
  client_boundaries_json TEXT NOT NULL DEFAULT '[]',
  data_sources_json TEXT NOT NULL DEFAULT '[]',
  backend_dependencies_json TEXT NOT NULL DEFAULT '[]',
  cache_behavior_json TEXT NOT NULL DEFAULT '[]',
  seo_type TEXT NOT NULL DEFAULT 'unknown',
  metadata_source TEXT,
  middleware_matchers_json TEXT NOT NULL DEFAULT '[]',
  created_sha TEXT,
  last_seen_sha TEXT,
  removed_sha TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(repository_id, route, source_file)
);
CREATE INDEX IF NOT EXISTS idx_routes_repo_active ON routes(repository_id, active, route);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  memory_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence TEXT NOT NULL,
  producer TEXT NOT NULL DEFAULT 'deterministic',
  quality_score REAL,
  source_hash TEXT,
  created_sha TEXT,
  updated_sha TEXT,
  removed_sha TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_memories_repo_type ON memories(repository_id, memory_type, active);

CREATE TABLE IF NOT EXISTS memory_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  symbol TEXT,
  start_line INTEGER,
  end_line INTEGER,
  file_hash TEXT,
  commit_sha TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_file ON memory_evidence(file_path, memory_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_id UNINDEXED,
  repository_id UNINDEXED,
  memory_type,
  subject,
  content,
  tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  dependency_type TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  purpose TEXT,
  runtime TEXT,
  config_key TEXT,
  source_file TEXT,
  source_symbol TEXT,
  start_line INTEGER,
  last_seen_sha TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(repository_id, dependency_type, name, source_file)
);
CREATE INDEX IF NOT EXISTS idx_dependencies_repo ON dependencies(repository_id, active, category);

CREATE TABLE IF NOT EXISTS route_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  dependency_id INTEGER NOT NULL REFERENCES dependencies(id) ON DELETE CASCADE,
  usage_type TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_symbol TEXT,
  start_line INTEGER,
  last_seen_sha TEXT,
  UNIQUE(route_id, dependency_id, usage_type, source_file)
);
CREATE INDEX IF NOT EXISTS idx_route_dependencies_route ON route_dependencies(route_id, usage_type);

CREATE TABLE IF NOT EXISTS index_run_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES index_runs(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('CREATE','DEACTIVATE','REUSE')),
  previous_hash TEXT,
  new_hash TEXT,
  source_file TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_run_changes_run ON index_run_changes(run_id, entity_type, operation);
`;
