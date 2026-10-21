PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  priority TEXT NOT NULL,
  success_criteria TEXT NOT NULL,
  expected_minutes INTEGER NOT NULL CHECK (expected_minutes >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_revisions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  snapshot_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  title TEXT NOT NULL,
  due_at TEXT,
  priority TEXT NOT NULL,
  category TEXT NOT NULL,
  expected_minutes INTEGER NOT NULL CHECK (expected_minutes >= 0),
  status TEXT NOT NULL CHECK (status IN ('todo','doing','done','blocked')),
  blocked_reason TEXT NOT NULL DEFAULT '',
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_plan_active ON tasks(plan_id, deleted_at);

CREATE TABLE IF NOT EXISTS execution_logs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  actual_minutes INTEGER NOT NULL CHECK (actual_minutes >= 0),
  difference_reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_task ON execution_logs(task_id);

CREATE TABLE IF NOT EXISTS reflections (
  plan_id TEXT PRIMARY KEY REFERENCES plans(id),
  next_step TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
