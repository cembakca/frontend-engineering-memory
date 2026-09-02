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
  package_name TEXT,
  query_aliases_json TEXT NOT NULL DEFAULT '{}',
  last_indexed_sha TEXT,
  last_indexed_at TEXT,
  -- Set when the registry stops listing a repository. Retirement hides it from
  -- every surface but keeps the rows, so re-adding the line brings it back.
  retired_at TEXT,
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
  segment_config_json TEXT NOT NULL DEFAULT '{}',
  control_flow_json TEXT NOT NULL DEFAULT '[]',
  rendering_basis TEXT NOT NULL DEFAULT 'observed',
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
CREATE INDEX IF NOT EXISTS idx_evidence_memory ON memory_evidence(memory_id);

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

CREATE TABLE IF NOT EXISTS repository_package_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  package_name TEXT NOT NULL,
  dependency_kind TEXT NOT NULL CHECK(dependency_kind IN ('runtime','development','optional','peer')),
  source_file TEXT NOT NULL DEFAULT 'package.json',
  last_seen_sha TEXT,
  UNIQUE(repository_id, package_name)
);
CREATE INDEX IF NOT EXISTS idx_repository_package_dependencies_package ON repository_package_dependencies(package_name, repository_id);

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

CREATE TABLE IF NOT EXISTS repository_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  routes_json TEXT NOT NULL,
  dependencies_json TEXT NOT NULL,
  memories_json TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repository_id, sha)
);
CREATE INDEX IF NOT EXISTS idx_repository_snapshots_repo_sha ON repository_snapshots(repository_id, sha);

CREATE TABLE IF NOT EXISTS repository_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  decision_key TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('proposed','accepted','rejected','superseded')),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('adr','pr','issue','human')),
  source_ref TEXT NOT NULL,
  source_sha TEXT,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  supersedes_decision_id INTEGER REFERENCES repository_decisions(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repository_id, decision_key, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_repository_decisions_repo_key ON repository_decisions(repository_id, decision_key, status);

-- RCE-024. Retrieval telemetry never stores fact content, evidence excerpts,
-- source code or configuration values. Only identifiers, counts and timings.
CREATE TABLE IF NOT EXISTS retrieval_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  intent TEXT,
  pack_kind TEXT,
  snapshot_sha TEXT,
  query_hash TEXT NOT NULL,
  query_shape_json TEXT NOT NULL,
  query_text TEXT,
  channels_json TEXT NOT NULL DEFAULT '[]',
  second_round INTEGER NOT NULL DEFAULT 0,
  result_ids_json TEXT NOT NULL DEFAULT '[]',
  result_count INTEGER NOT NULL DEFAULT 0,
  payload_chars INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  fallback TEXT NOT NULL DEFAULT 'none',
  miss_class TEXT,
  gaps_json TEXT NOT NULL DEFAULT '[]',
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_retrieval_events_repo_time ON retrieval_events(repository_id, created_at);
CREATE INDEX IF NOT EXISTS idx_retrieval_events_miss ON retrieval_events(miss_class, created_at);

-- RCE-025. A feedback signal is worth keeping only if it becomes an evaluation
-- case, so every row carries the state that moves it through the backlog.
CREATE TABLE IF NOT EXISTS answer_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  retrieval_event_id INTEGER REFERENCES retrieval_events(id) ON DELETE SET NULL,
  query_hash TEXT NOT NULL,
  signal TEXT NOT NULL CHECK(signal IN ('sufficient','source-needed','wrong','stale')),
  reporter TEXT NOT NULL DEFAULT 'unknown',
  note TEXT,
  snapshot_sha TEXT,
  backlog_state TEXT NOT NULL DEFAULT 'new' CHECK(backlog_state IN ('new','triaged','case-created','dismissed')),
  case_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_answer_feedback_repo_state ON answer_feedback(repository_id, backlog_state, created_at);
CREATE INDEX IF NOT EXISTS idx_answer_feedback_query ON answer_feedback(query_hash, signal);
`;
