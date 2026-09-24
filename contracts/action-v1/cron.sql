-- Contract fixture only. PR 3 owns migrations and scheduler runtime.
-- All timestamps: UTC epoch milliseconds. NULL project is profile scope.
PRAGMA foreign_keys = ON;
CREATE TABLE cron_jobs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  project_id TEXT,
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL,
  action TEXT NOT NULL,
  arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json) AND json_type(arguments_json) = 'object'),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  last_run_at INTEGER,
  next_run_at INTEGER NOT NULL,
  last_status TEXT CHECK(last_status IN ('running','succeeded','failed','rejected','unknown')),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX cron_jobs_due ON cron_jobs(enabled, next_run_at);
CREATE INDEX cron_jobs_scope ON cron_jobs(profile_id, project_id);
-- This is the shared action history, including non-cron callers.
CREATE TABLE action_executions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  project_id TEXT,
  scope_key TEXT GENERATED ALWAYS AS (coalesce(project_id, '')) STORED,
  action TEXT NOT NULL,
  arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json) AND json_type(arguments_json) = 'object'),
  trigger TEXT NOT NULL CHECK(trigger IN ('user','cron','durable_task','webhook','system')),
  idempotency_key TEXT NOT NULL,
  cron_id TEXT REFERENCES cron_jobs(id) ON DELETE SET NULL,
  scheduled_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('claimed','running','succeeded','failed','rejected','unknown')),
  lease_owner TEXT,
  lease_until INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  started_at INTEGER,
  finished_at INTEGER,
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  created_at INTEGER NOT NULL,
  UNIQUE(profile_id, scope_key, idempotency_key)
);
CREATE UNIQUE INDEX cron_occurrence ON action_executions(cron_id, scheduled_at)
  WHERE cron_id IS NOT NULL AND scheduled_at IS NOT NULL;
CREATE INDEX action_history_scope ON action_executions(profile_id, project_id, created_at);
