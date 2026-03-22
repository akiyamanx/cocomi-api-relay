// COCOMI Agent Hub — コスト管理モジュール
// Version: 1.0.0
// 設計書v1.0.0 セクション5 + 構想カプセルv0.3 コスト制御に準拠
// コスト記録・集計・閾値チェック・自動停止を担う。agent-hubのブレーキ機構の心臓部。
'use strict';

import { safeExecute, safeQuery, generateId } from '../../shared/d1-helpers.js';
import { TASK_COST_LIMITS, getDailyKey, getMonthlyKey, COST_DEFAULTS } from '../../shared/constants.js';
import { writeAuditLog } from './audit.js';

// === コスト記録 ===
// API呼び出し後にトークン数×単価でコストを計算し、cost_logに記録する
// 記録後に閾値チェックも実行（常にブレーキ監視）
export async function recordCost(db, env, {
  proposalId = null,
  actionType,
  provider,
  model = null,
  inputTokens = 0,
  outputTokens = 0,
  costMicroUsd,
  metadata = null,
}) {
  const id = generateId('cost');
  const dailyKey = getDailyKey();
  const monthlyKey = getMonthlyKey();
  const now = new Date().toISOString();

  // cost_logにINSERT
  await safeExecute(db,
    `INSERT INTO cost_log (id, proposal_id, action_type, provider, model, input_tokens, output_tokens, cost_micro_usd, daily_key, monthly_key, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, proposalId, actionType, provider, model, inputTokens, outputTokens, costMicroUsd, dailyKey, monthlyKey, metadata ? JSON.stringify(metadata) : null, now]
  );

  // proposalIdがある場合、proposalsのactual_cost_micro_usdを加算
  if (proposalId) {
    await safeExecute(db,
      `UPDATE proposals SET actual_cost_micro_usd = actual_cost_micro_usd + ?, updated_at = ? WHERE id = ?`,
      [costMicroUsd, now, proposalId]
    );
  }

  // 閾値チェック実行（常にブレーキ監視）
  const limitResult = await checkCostLimits(db, env);

  // ハード上限到達時は自動停止を発動
  if (limitResult.shouldStop) {
    await activateEmergencyStop(db, limitResult.reason);
  }

  // ソフト警告時は監査ログに記録
  if (limitResult.status === 'soft_warning') {
    await writeAuditLog(db, {
      actorUserId: 'system',
      action: 'cost_soft_warning',
      resourceType: 'cost',
      resourceId: id,
      detail: { dailyCost: limitResult.dailyCost, monthlyCost: limitResult.monthlyCost, reason: limitResult.reason },
    });
  }

  return { id, dailyKey, monthlyKey, costMicroUsd, limitResult };
}

// === 日次コスト集計 ===
// cost_logテーブルからdaily_keyでSUM(cost_micro_usd)を取得
export async function getDailyCost(db, dailyKey = null) {
  const key = dailyKey || getDailyKey();
  const result = await safeQuery(db,
    `SELECT COALESCE(SUM(cost_micro_usd), 0) as total FROM cost_log WHERE daily_key = ?`,
    [key]
  );
  return result.results[0]?.total || 0;
}

// === 月次コスト集計 ===
// cost_logテーブルからmonthly_keyでSUM(cost_micro_usd)を取得
export async function getMonthlyCost(db, monthlyKey = null) {
  const key = monthlyKey || getMonthlyKey();
  const result = await safeQuery(db,
    `SELECT COALESCE(SUM(cost_micro_usd), 0) as total FROM cost_log WHERE monthly_key = ?`,
    [key]
  );
  return result.results[0]?.total || 0;
}

// === 閾値チェック（3層コスト制御） ===
// 設計書v1.0.0 セクション5-1: タスク単位 / 日次 / 月次の3層
// 判定結果: ok / soft_warning / hard_stop
export async function checkCostLimits(db, env) {
  const dailyCost = await getDailyCost(db);
  const monthlyCost = await getMonthlyCost(db);

  // 環境変数から閾値を取得（未設定時はデフォルト値を使用）
  const dailySoftLimit = parseInt(env.DAILY_COST_SOFT_LIMIT_MICRO_USD || COST_DEFAULTS.DAILY_SOFT_LIMIT);
  const dailyHardLimit = parseInt(env.DAILY_COST_HARD_LIMIT_MICRO_USD || COST_DEFAULTS.DAILY_HARD_LIMIT);
  const monthlyHardLimit = parseInt(env.MONTHLY_COST_HARD_LIMIT_MICRO_USD || COST_DEFAULTS.MONTHLY_HARD_LIMIT);

  // 月次ハード上限チェック（最優先）
  if (monthlyCost >= monthlyHardLimit) {
    return {
      dailyCost, monthlyCost,
      status: 'hard_stop',
      reason: `月次コスト上限到達: ${formatMicroUsd(monthlyCost)} / ${formatMicroUsd(monthlyHardLimit)}`,
      shouldStop: true,
    };
  }

  // 日次ハード上限チェック
  if (dailyCost >= dailyHardLimit) {
    return {
      dailyCost, monthlyCost,
      status: 'hard_stop',
      reason: `日次コスト上限到達: ${formatMicroUsd(dailyCost)} / ${formatMicroUsd(dailyHardLimit)}`,
      shouldStop: true,
    };
  }

  // 日次ソフト上限チェック（通知のみ、処理は継続）
  if (dailyCost >= dailySoftLimit) {
    return {
      dailyCost, monthlyCost,
      status: 'soft_warning',
      reason: `日次コスト警告(80%): ${formatMicroUsd(dailyCost)} / ${formatMicroUsd(dailyHardLimit)}`,
      shouldStop: false,
    };
  }

  // 問題なし
  return {
    dailyCost, monthlyCost,
    status: 'ok',
    reason: null,
    shouldStop: false,
  };
}

// === 自動停止実行 ===
// ハード上限到達時にemergency_stopを有効化する
export async function activateEmergencyStop(db, reason) {
  const now = new Date().toISOString();

  // agent_configのemergency_stopを'true'に更新
  await safeExecute(db,
    `UPDATE agent_config SET value = 'true', updated_by = 'system', updated_at = ? WHERE key = 'emergency_stop'`,
    [now]
  );

  // 実行中の全タスクを停止（proposals.status = 'running' → 'stopped'）
  await safeExecute(db,
    `UPDATE proposals SET status = 'stopped', stopped_at = ?, stop_reason = ?, updated_at = ? WHERE status = 'running'`,
    [now, reason, now]
  );

  // 監査ログに記録
  await writeAuditLog(db, {
    actorUserId: 'system',
    action: 'emergency_stop',
    resourceType: 'config',
    resourceId: 'emergency_stop',
    detail: { reason, activatedAt: now },
  });

  // TODO: Sprint 5でLINE通知を追加
}

// === コストステータス取得（/status API用） ===
// 日次/月次コストと閾値情報をまとめて返す
export async function getCostStatus(db, env) {
  const dailyCost = await getDailyCost(db);
  const monthlyCost = await getMonthlyCost(db);

  const dailySoftLimit = parseInt(env.DAILY_COST_SOFT_LIMIT_MICRO_USD || COST_DEFAULTS.DAILY_SOFT_LIMIT);
  const dailyHardLimit = parseInt(env.DAILY_COST_HARD_LIMIT_MICRO_USD || COST_DEFAULTS.DAILY_HARD_LIMIT);
  const monthlyHardLimit = parseInt(env.MONTHLY_COST_HARD_LIMIT_MICRO_USD || COST_DEFAULTS.MONTHLY_HARD_LIMIT);

  // 現在のステータス判定
  const limitResult = await checkCostLimits(db, env);

  return {
    daily: {
      cost: dailyCost,
      costFormatted: formatMicroUsd(dailyCost),
      softLimit: dailySoftLimit,
      hardLimit: dailyHardLimit,
      percentage: dailyHardLimit > 0 ? Math.round((dailyCost / dailyHardLimit) * 100) : 0,
    },
    monthly: {
      cost: monthlyCost,
      costFormatted: formatMicroUsd(monthlyCost),
      hardLimit: monthlyHardLimit,
      percentage: monthlyHardLimit > 0 ? Math.round((monthlyCost / monthlyHardLimit) * 100) : 0,
    },
    status: limitResult.status,
    reason: limitResult.reason,
  };
}

// === micro_usdをドル表記に変換するヘルパー ===
function formatMicroUsd(microUsd) {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}
