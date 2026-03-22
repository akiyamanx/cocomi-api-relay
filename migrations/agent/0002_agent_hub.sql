-- 0002_agent_hub.sql: Phase 1 初期テーブル
-- Version: 1.0.0
-- 設計書v1.0.0 セクション3-2準拠

-- 1. users — ユーザー管理
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  line_user_id TEXT UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'user', 'viewer')),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- systemユーザー初期投入
INSERT OR IGNORE INTO users (id, line_user_id, display_name, role, status, created_at, updated_at)
VALUES ('system', NULL, 'System', 'admin', 'active', datetime('now'), datetime('now'));

-- アキヤ初期投入（line_user_idは後で更新）
INSERT OR IGNORE INTO users (id, line_user_id, display_name, role, status, created_at, updated_at)
VALUES ('akiya', NULL, 'アキヤ', 'owner', 'active', datetime('now'), datetime('now'));

-- 2. permissions — 権限定義
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'role')),
  subject_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  conditions_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 初期権限: ownerは全操作許可
INSERT OR IGNORE INTO permissions (id, subject_type, subject_id, resource, action, effect, created_at, updated_at)
VALUES ('perm_owner_all', 'role', 'owner', '*', '*', 'allow', datetime('now'), datetime('now'));

-- 初期権限: systemはstop/auto_stopのみ
INSERT OR IGNORE INTO permissions (id, subject_type, subject_id, resource, action, effect, created_at, updated_at)
VALUES ('perm_system_stop', 'user', 'system', 'proposal', 'stop', 'allow', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO permissions (id, subject_type, subject_id, resource, action, effect, created_at, updated_at)
VALUES ('perm_system_auto_stop', 'user', 'system', 'proposal', 'system_auto_stop', 'allow', datetime('now'), datetime('now'));

-- 3. proposals — 提案/タスク本体
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  proposer_user_id TEXT NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'assist', 'manual')),
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'submitted', 'revision_requested', 'approved', 'rejected',
    'scheduled', 'running', 'paused', 'completed', 'failed', 'cancelled', 'stopped'
  )),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  estimated_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  approved_budget_micro_usd INTEGER NOT NULL DEFAULT 0,
  actual_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  auto_stop_enabled INTEGER NOT NULL DEFAULT 1,
  execution_deadline_at TEXT,
  submitted_at TEXT,
  approved_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  stopped_at TEXT,
  stop_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 4. proposal_actions — 状態遷移ログ
CREATE TABLE IF NOT EXISTS proposal_actions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  action TEXT NOT NULL CHECK (action IN (
    'create', 'submit', 'request_revision', 'revise', 'approve', 'reject',
    'schedule', 'start', 'pause', 'resume', 'complete', 'fail', 'cancel', 'stop', 'system_auto_stop'
  )),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  comment TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposal_actions_proposal_id ON proposal_actions(proposal_id);
CREATE INDEX IF NOT EXISTS idx_proposal_actions_created_at ON proposal_actions(created_at);

-- 5. cost_log — コスト記録
CREATE TABLE IF NOT EXISTS cost_log (
  id TEXT PRIMARY KEY,
  proposal_id TEXT REFERENCES proposals(id),
  action_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  daily_key TEXT NOT NULL,
  monthly_key TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cost_log_daily_key ON cost_log(daily_key);
CREATE INDEX IF NOT EXISTS idx_cost_log_monthly_key ON cost_log(monthly_key);
CREATE INDEX IF NOT EXISTS idx_cost_log_proposal_id ON cost_log(proposal_id);

-- 6. audit_log — 監査ログ
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  detail_json TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id);
