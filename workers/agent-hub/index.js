// COCOMI Agent Hub — エントリポイント・ルーティング
// Version: 1.2.0（Sprint 3: 権限ガード + 監査ログ強化 + /audit/logsエンドポイント追加）
// エージェント統制基盤のメインエントリポイント
'use strict';

import { getCostStatus } from './cost.js';
import { writeAuditLog, logRequest, getAuditLogs } from './audit.js';
import { requirePermission } from './permission.js';
import { safeExecute, safeQuery } from '../../shared/d1-helpers.js';

export default {
  async fetch(request, env, ctx) {
    const db = env.DB;

    // CORS対応ヘッダ
    const corsHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Auth-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };

    // OPTIONSプリフライト対応
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 認証チェック（全リクエスト共通）
    const authToken = request.headers.get('X-Agent-Auth-Token');
    if (authToken !== env.AGENT_AUTH_TOKEN) {
      return new Response(
        JSON.stringify({ error: '認証エラー' }),
        { status: 401, headers: corsHeaders }
      );
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // === ユーザー特定 ===
    // Phase 1: トークン認証が通った = akiya（ownerロール）
    // Sprint 4以降でLINE user_id等による動的ユーザー特定に拡張
    const currentUserId = 'akiya';

    try {
      // === emergency_stop / maintenance_mode チェック ===
      // GETリクエスト以外（書き込み系）の入口で必ずチェック
      // ただし /emergency-stop 自体は常にアクセス可能（解除できなくなるため）
      if (method !== 'GET' && path !== '/emergency-stop') {
        const configResult = await safeQuery(db,
          `SELECT key, value FROM agent_config WHERE key IN ('emergency_stop', 'maintenance_mode')`
        );
        const config = {};
        for (const row of configResult.results || []) {
          config[row.key] = row.value;
        }

        // emergency_stop中は全書き込み拒否
        if (config.emergency_stop === 'true') {
          await writeAuditLog(db, {
            actorUserId: 'system',
            action: 'permission_denied',
            resourceType: 'system',
            detail: { reason: '緊急停止中のため書き込み拒否', path, method },
          });
          return new Response(
            JSON.stringify({ error: '緊急停止中です。書き込み操作はできません。' }),
            { status: 503, headers: corsHeaders }
          );
        }

        // maintenance_mode中は全書き込み拒否（read-only化）
        if (config.maintenance_mode === 'true') {
          return new Response(
            JSON.stringify({ error: 'メンテナンスモード中です。読み取り専用です。' }),
            { status: 503, headers: corsHeaders }
          );
        }
      }

      // === ルーティング ===

      // ヘルスチェック（権限チェック不要）
      if (path === '/health' && method === 'GET') {
        return new Response(
          JSON.stringify({ status: 'ok', version: '1.2.0', worker: 'agent-hub' }),
          { headers: corsHeaders }
        );
      }

      // ステータス（コスト情報 + タスク件数 + フラグ情報）— 権限チェック付き
      if (path === '/status' && method === 'GET') {
        const perm = await requirePermission(db, {
          userId: currentUserId, resource: 'status', action: 'read'
        });
        if (!perm.allowed) return perm.response;
        // コスト情報取得
        const costStatus = await getCostStatus(db, env);

        // agent_configからフラグ取得
        const configResult = await safeQuery(db,
          `SELECT key, value FROM agent_config WHERE key IN ('emergency_stop', 'maintenance_mode', 'low_cost_mode')`
        );
        const flags = {};
        for (const row of configResult.results || []) {
          flags[row.key] = row.value === 'true';
        }

        // 稼働中・承認待ち・停止/失敗タスク件数
        const taskCounts = await safeQuery(db,
          `SELECT status, COUNT(*) as count FROM proposals WHERE status IN ('running', 'submitted', 'stopped', 'failed') GROUP BY status`
        );
        const counts = { running: 0, submitted: 0, stopped: 0, failed: 0 };
        for (const row of taskCounts.results || []) {
          counts[row.status] = row.count;
        }

        return new Response(
          JSON.stringify({
            status: 'ok',
            message: 'agent-hub稼働中',
            cost: costStatus,
            tasks: {
              running: counts.running,
              pending_approval: counts.submitted,
              stopped: counts.stopped,
              failed: counts.failed,
            },
            flags: {
              emergency_stop: flags.emergency_stop || false,
              maintenance_mode: flags.maintenance_mode || false,
              low_cost_mode: flags.low_cost_mode || false,
            },
          }),
          { headers: corsHeaders }
        );
      }

      // 緊急停止（POST /emergency-stop）— 権限チェック付き
      // emergency_stop中でもアクセス可能（解除のために必要）
      if (path === '/emergency-stop' && method === 'POST') {
        const perm = await requirePermission(db, {
          userId: currentUserId, resource: 'config', action: 'emergency_stop'
        });
        if (!perm.allowed) return perm.response;

        const body = await request.json();
        const action = body.action; // 'activate' or 'deactivate'
        const now = new Date().toISOString();

        if (action === 'activate') {
          // emergency_stopを有効化
          await safeExecute(db,
            `UPDATE agent_config SET value = 'true', updated_by = 'system', updated_at = ? WHERE key = 'emergency_stop'`,
            [now]
          );

          // 実行中の全タスクを停止
          const stoppedResult = await safeExecute(db,
            `UPDATE proposals SET status = 'stopped', stopped_at = ?, stop_reason = '手動緊急停止', updated_at = ? WHERE status = 'running'`,
            [now, now]
          );

          // 監査ログ記録
          await writeAuditLog(db, {
            actorUserId: currentUserId,
            action: 'emergency_stop',
            resourceType: 'config',
            resourceId: 'emergency_stop',
            detail: { trigger: 'manual', stoppedTasks: stoppedResult?.meta?.changes || 0 },
          });

          // POSTリクエストログ記録（非同期、主処理ブロックしない）
          ctx.waitUntil(logRequest(db, { method, path, userId: currentUserId, resultStatus: 200 }));

          return new Response(
            JSON.stringify({
              status: 'activated',
              message: '緊急停止を発動しました。全タスクを停止しました。',
              stoppedTasks: stoppedResult?.meta?.changes || 0,
            }),
            { headers: corsHeaders }
          );
        }

        if (action === 'deactivate') {
          // emergency_stopを解除
          await safeExecute(db,
            `UPDATE agent_config SET value = 'false', updated_by = ?, updated_at = ? WHERE key = 'emergency_stop'`,
            [currentUserId, now]
          );

          // 監査ログ記録
          await writeAuditLog(db, {
            actorUserId: currentUserId,
            action: 'emergency_stop_deactivated',
            resourceType: 'config',
            resourceId: 'emergency_stop',
            detail: { deactivatedAt: now },
          });

          // POSTリクエストログ記録
          ctx.waitUntil(logRequest(db, { method, path, userId: currentUserId, resultStatus: 200 }));

          return new Response(
            JSON.stringify({
              status: 'deactivated',
              message: '緊急停止を解除しました。',
            }),
            { headers: corsHeaders }
          );
        }

        // activate/deactivate以外のactionはエラー
        return new Response(
          JSON.stringify({ error: 'actionは "activate" または "deactivate" を指定してください' }),
          { status: 400, headers: corsHeaders }
        );
      }

      // コストステータス（GET /cost/status — 詳細版）— 権限チェック付き
      if (path === '/cost/status' && method === 'GET') {
        const perm = await requirePermission(db, {
          userId: currentUserId, resource: 'cost', action: 'read'
        });
        if (!perm.allowed) return perm.response;
        const costStatus = await getCostStatus(db, env);
        return new Response(
          JSON.stringify(costStatus),
          { headers: corsHeaders }
        );
      }

      // 【Sprint 3追加】監査ログ取得（GET /audit/logs）— 権限チェック付き
      if (path === '/audit/logs' && method === 'GET') {
        const perm = await requirePermission(db, {
          userId: currentUserId, resource: 'audit', action: 'read'
        });
        if (!perm.allowed) return perm.response;

        // クエリパラメータからフィルタ条件を取得
        const params = Object.fromEntries(url.searchParams);
        const logs = await getAuditLogs(db, {
          limit: parseInt(params.limit) || 20,
          action: params.action,
          resourceType: params.resource_type,
          actorUserId: params.actor,
          since: params.since,
        });
        return new Response(
          JSON.stringify({ status: 'ok', logs }),
          { headers: corsHeaders }
        );
      }

      // TODO: Sprint 4でタスクCRUDルーティング追加
      // POST /tasks — タスク作成
      // GET /tasks/:id — タスク取得
      // GET /tasks — タスク一覧
      // POST /tasks/:id/approve — タスク承認
      // POST /tasks/:id/reject — タスク却下
      // POST /tasks/:id/cancel — タスクキャンセル

      // 該当なし
      return new Response(
        JSON.stringify({ error: 'Not Found' }),
        { status: 404, headers: corsHeaders }
      );

    } catch (err) {
      // 内部エラー（詳細はログのみ、ユーザーには汎用メッセージ）
      console.error('[agent-hub] Internal error:', err.message, err.stack);
      return new Response(
        JSON.stringify({ error: '内部エラーが発生しました' }),
        { status: 500, headers: corsHeaders }
      );
    }
  }
};
