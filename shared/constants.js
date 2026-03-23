// COCOMI共通定数
// Version: 1.2.0（Sprint 3: 権限関連定数追加）
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

// === タスク種別ごとのコスト上限（micro_usd）===
// 構想カプセルv0.3 + 設計書v1.0.0 セクション5-1 準拠
export const TASK_COST_LIMITS = {
  light_research: 100_000,   // 軽調査 $0.10
  deep_research: 500_000,    // 深掘り $0.50
  meeting: 1_000_000,        // 会議 $1.00
};

// === コスト日次/月次キー生成ヘルパー ===
// daily_key: 'YYYYMMDD', monthly_key: 'YYYYMM'
// JSTに変換して生成する（タイムゾーン: Asia/Tokyo）
function toJST(date) {
  return new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}

function zeroPad(n) {
  return String(n).padStart(2, '0');
}

export function getDailyKey(date = new Date()) {
  const jst = toJST(date);
  return `${jst.getFullYear()}${zeroPad(jst.getMonth() + 1)}${zeroPad(jst.getDate())}`;
}

export function getMonthlyKey(date = new Date()) {
  const jst = toJST(date);
  return `${jst.getFullYear()}${zeroPad(jst.getMonth() + 1)}`;
}

// === 権限関連定数（Sprint 3追加） ===

// リソース種別一覧（権限判定で使用）
export const RESOURCES = [
  'proposal', 'config', 'cost', 'audit', 'status', 'permission'
];

// アクション種別一覧（権限判定で使用）
export const ACTIONS = [
  'create', 'read', 'update', 'delete',
  'approve', 'reject', 'cancel',
  'stop', 'emergency_stop',
  'submit', 'start', 'pause', 'resume', 'complete', 'fail'
];

// === 監査ログアクション定義 ===
// 設計書v1.0.0 セクション1-6 の項目に対応
export const AUDIT_ACTIONS = [
  'task_created',
  'task_approved',
  'task_started',
  'task_completed',
  'task_failed',
  'permission_denied',
  'cost_limit_hit',
  'cost_soft_warning',
  'emergency_stop',
  'emergency_stop_deactivated',
  'maintenance_mode_on',
  'maintenance_mode_off',
  'system_error',
  'api_request',
];
