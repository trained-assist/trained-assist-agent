'use strict';

// Additive plan-persistence migration. Legacy tier columns remain readable until
// the executor runtime is migrated; new plans use independent role/level/budget.
module.exports = function migratePlan(db) {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='durable_tasks'").get().sql;
      if (!schema.includes("'draft'")) {
        db.exec(schema.replace('durable_tasks', 'durable_tasks_new').replace("'active','done','failed','cancelled'", "'draft','active','paused','blocked','done','failed','cancelled'"));
        db.exec('INSERT INTO durable_tasks_new SELECT * FROM durable_tasks; DROP TABLE durable_tasks; ALTER TABLE durable_tasks_new RENAME TO durable_tasks;');
      }
      const additions = {
        durable_tasks: {
          playbook_id: 'TEXT', playbook_version: 'INTEGER', user_value: 'TEXT',
          acceptance_criteria_json: 'TEXT', contract_revision: 'INTEGER NOT NULL DEFAULT 1',
          execution_policy_json: 'TEXT', execution_session_id: 'TEXT', request_id: 'TEXT', blocker_reason: 'TEXT',
        },
        task_items: {
          stage: 'TEXT', instructions: 'TEXT', execution_kind: "TEXT NOT NULL DEFAULT 'agent' CHECK(execution_kind IN ('agent','programmatic'))",
          executor_role: "TEXT CHECK(executor_role IN ('researcher','developer','reviewer','verifier'))",
          minimum_model_level: "TEXT CHECK(minimum_model_level IN ('bachelor','master','doctor'))",
          current_model_level: "TEXT CHECK(current_model_level IN ('bachelor','master','doctor'))",
          context_budget: "TEXT CHECK(context_budget IN ('small','medium','large'))", validation_json: 'TEXT',
          // P3d-1c: per-step validation_mode override (nullable). NULL → inherit
          // the plan's execution_policy_json.validation_mode; a set value beats it.
          validation_mode: "TEXT CHECK(validation_mode IN ('programmatic','programmatic+llm','programmatic+llm-fastpass'))",
          attempt_count: 'INTEGER NOT NULL DEFAULT 0', max_attempts: 'INTEGER NOT NULL DEFAULT 3',
          execution_timeout_seconds: 'INTEGER NOT NULL DEFAULT 600', wait_deadline_at: 'INTEGER', evidence_json: 'TEXT', completed_at: 'INTEGER',
        },
        executions: { executor_role: 'TEXT', model_level: 'TEXT', context_budget: 'TEXT', profile: 'TEXT', provider: 'TEXT', attempt_number: 'INTEGER', result_json: 'TEXT' },
      };
      for (const [table, columns] of Object.entries(additions)) {
        const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
        for (const [column, type] of Object.entries(columns)) {
          if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        }
      }
      db.exec(`UPDATE task_items SET
        minimum_model_level = CASE execution_tier WHEN 'free' THEN 'bachelor' WHEN 'standard' THEN 'master' ELSE 'doctor' END,
        current_model_level = CASE current_tier WHEN 'free' THEN 'bachelor' WHEN 'standard' THEN 'master' ELSE 'doctor' END,
        executor_role = COALESCE(executor_role, 'developer'), context_budget = COALESCE(context_budget, 'small')
        WHERE execution_kind = 'agent' AND minimum_model_level IS NULL;
        CREATE TABLE IF NOT EXISTS task_validation_results (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
          task_item_id TEXT REFERENCES task_items(id), execution_id TEXT REFERENCES executions(id),
          criterion_id TEXT NOT NULL, contract_revision INTEGER NOT NULL, validator TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pass','fail','inconclusive')),
          subject_json TEXT, evidence_json TEXT, created_at INTEGER NOT NULL
        );`);
      if (db.pragma('foreign_key_check').length) throw new Error('plan migration foreign key check failed');
    })();
  } finally { db.pragma('foreign_keys = ON'); }
};
