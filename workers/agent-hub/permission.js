// COCOMI Agent Hub — 権限判定モジュール
// Version: 1.0.0
// 設計書v1.0.0 セクション1-5 + セクション3-2 permissionsテーブルに準拠
// deny > allow、user > role の優先順位で権限を判定する
'use strict';

import { safeQuery } from '../../shared/d1-helpers.js';
import { writeAuditLog } from './audit.js';

// === ユーザー取得 ===
// ユーザーIDからusersテーブルの情報を取得
// 見つからなければ null を返す
export async function getUser(db, userId) {
  const result = await safeQuery(db,
    `SELECT id, line_user_id, display_name, role, status, timezone FROM users WHERE id = ?`,
    [userId]
  );
  const rows = result.results || [];
  return rows.length > 0 ? rows[0] : null;
}

// === 権限判定メイン関数 ===
// 指定のユーザーが、指定のリソース・アクションを実行できるか判定
// 優先順位: 1) ユーザー単位deny 2) ロール単位deny 3) ユーザー単位allow 4) ロール単位allow
// どれにもマッチしない場合はデフォルト拒否（安全側に倒す）
export async function checkPermission(db, { userId, resource, action }) {
  // 1. ユーザー情報取得
  const user = await getUser(db, userId);

  // ユーザーが存在しない場合は拒否
  if (!user) {
    return {
      allowed: false,
      userId,
      role: null,
      resource,
      action,
      reason: 'ユーザーが存在しません',
    };
  }

  // ユーザーがinactiveの場合は拒否
  if (user.status !== 'active') {
    return {
      allowed: false,
      userId,
      role: user.role,
      resource,
      action,
      reason: 'ユーザーが無効化されています',
    };
  }

  // 2. permissionsテーブルを検索
  // ユーザー単位とロール単位の権限を一括取得
  // ワイルドカード（'*'）もマッチさせる
  // deny優先 → user優先 の順でソート
  const permResult = await safeQuery(db,
    `SELECT subject_type, subject_id, resource, action, effect
     FROM permissions
     WHERE ((subject_type = 'user' AND subject_id = ?)
        OR  (subject_type = 'role' AND subject_id = ?))
       AND (resource = ? OR resource = '*')
       AND (action = ? OR action = '*')
     ORDER BY
       CASE effect WHEN 'deny' THEN 0 ELSE 1 END,
       CASE subject_type WHEN 'user' THEN 0 ELSE 1 END
     LIMIT 1`,
    [userId, user.role, resource, action]
  );

  const matches = permResult.results || [];

  // 3. マッチする権限レコードがあるか判定
  if (matches.length > 0) {
    const match = matches[0];

    if (match.effect === 'deny') {
      // 明示的なdeny → 拒否
      return {
        allowed: false,
        userId,
        role: user.role,
        resource,
        action,
        reason: `明示的に拒否されています (${match.subject_type}:${match.subject_id})`,
      };
    }

    // allow → 許可
    return {
      allowed: true,
      userId,
      role: user.role,
      resource,
      action,
      reason: `許可 (${match.subject_type}:${match.subject_id})`,
    };
  }

  // 4. どの権限にもマッチしない → デフォルト拒否
  return {
    allowed: false,
    userId,
    role: user.role,
    resource,
    action,
    reason: '該当する権限がありません',
  };
}

// === 権限チェック + 監査ログ統合ヘルパー ===
// checkPermissionを呼んで、拒否された場合はaudit_logに記録しレスポンスを返す
// index.jsの各エンドポイントで使う想定
export async function requirePermission(db, { userId, resource, action }) {
  const result = await checkPermission(db, { userId, resource, action });

  if (!result.allowed) {
    // 拒否された場合は監査ログに記録
    await writeAuditLog(db, {
      actorUserId: userId || 'anonymous',
      action: 'permission_denied',
      resourceType: resource,
      detail: {
        requestedAction: action,
        role: result.role,
        reason: result.reason,
      },
    });

    return {
      allowed: false,
      response: new Response(
        JSON.stringify({
          error: '権限がありません',
          resource,
          action,
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      ),
    };
  }

  // 許可
  return { allowed: true };
}
