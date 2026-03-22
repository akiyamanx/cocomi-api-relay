// COCOMI共通定数
// Version: 1.0.1
// relay Worker と agent-hub Worker で共有する定数定義

// agent-hubが所有するテーブル（書き込みOK）
export const AGENT_TABLES = [
  'users',
  'permissions',
  'proposals',
  'proposal_actions',
  'cost_log',
  'audit_log',
  'agent_config',
  'agent_checkpoints'
];

// 保護対象テーブル（agent-hubからはREAD ONLY）
export const PROTECTED_TABLES = [
  'memories',
  'memory_metadata',
  // relay側の他テーブルが判明したら追加 [要確認]
];

// タスク状態の定義
export const PROPOSAL_STATUSES = [
  'draft',
  'submitted',
  'revision_requested',
  'approved',
  'rejected',
  'scheduled',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'stopped',
];

// タスクアクションの定義
export const PROPOSAL_ACTIONS = [
  'create',
  'submit',
  'request_revision',
  'revise',
  'approve',
  'reject',
  'schedule',
  'start',
  'pause',
  'resume',
  'complete',
  'fail',
  'cancel',
  'stop',
  'system_auto_stop',
];

// リスクレベル
export const RISK_LEVELS = ['low', 'medium', 'high'];

// ユーザーロール
export const USER_ROLES = ['owner', 'admin', 'user', 'viewer'];

// コスト制御デフォルト値（micro_usd: $1.00 = 1,000,000）
export const COST_DEFAULTS = {
  DAILY_HARD_LIMIT: 1_000_000,   // $1.00
  MONTHLY_HARD_LIMIT: 10_000_000, // $10.00
  DAILY_SOFT_LIMIT: 700_000,      // $0.70
};
