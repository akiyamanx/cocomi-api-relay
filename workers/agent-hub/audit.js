// COCOMI Agent Hub — 監査ログモジュール
// Version: 1.0.0
// 設計書v1.0.0 セクション1-6 + セクション3-2 audit_logテーブルに準拠
// 全ての重要な操作を記録する。エラー時も主処理をブロックしない。
'use strict';

import { safeExecute, safeQuery, generateId } from '../../shared/d1-helpers.js';

// === 監査ログ記録 ===
// CLAUDE.md「通知処理の失敗は主処理をブロックしない」準拠
// エラー時はconsole.errorで記録し、throwしない
export async function writeAuditLog(db, {
  actorUserId,
  action,
  resourceType,
  resourceId = null,
  detail = null,
  ipAddress = null,
}) {
  try {
    const id = generateId('audit');
    const now = new Date().toISOString();
    const detailJson = detail ? JSON.stringify(detail) : null;

    await safeExecute(db,
      `INSERT INTO audit_log (id, actor_user_id, action, resource_type, resource_id, detail_json, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, actorUserId, action, resourceType, resourceId, detailJson, ipAddress, now]
    );

    return { id };
  } catch (err) {
    // 監査ログの書き込み失敗で主処理を止めない
    console.error('[audit] writeAuditLog failed:', err.message);
    return null;
  }
}

// === 監査ログ取得（管理用） ===
// フィルタ条件付きでaudit_logを取得（新しい順）
export async function getAuditLogs(db, { limit = 20, resourceType, action } = {}) {
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const params = [];

  // リソースタイプでフィルタ
  if (resourceType) {
    sql += ' AND resource_type = ?';
    params.push(resourceType);
  }

  // アクションでフィルタ
  if (action) {
    sql += ' AND action = ?';
    params.push(action);
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const result = await safeQuery(db, sql, params);
  return result.results || [];
}
