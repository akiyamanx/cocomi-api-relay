// COCOMI Agent Hub — エントリポイント・ルーティング
// Version: 1.0.0
// エージェント統制基盤のメインエントリポイント
'use strict';

export default {
  async fetch(request, env, ctx) {
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

    try {
      // --- ルーティング ---

      // ヘルスチェック
      if (path === '/health' && request.method === 'GET') {
        return new Response(
          JSON.stringify({ status: 'ok', version: '1.0.0', worker: 'agent-hub' }),
          { headers: corsHeaders }
        );
      }

      // 状態確認
      if (path === '/status' && request.method === 'GET') {
        // TODO: Sprint 2でコスト情報を含める
        // TODO: Sprint 4で稼働中タスク件数を含める
        return new Response(
          JSON.stringify({
            status: 'ok',
            message: 'agent-hub稼働中',
            emergency_stop: false,
            maintenance_mode: false,
          }),
          { headers: corsHeaders }
        );
      }

      // 緊急停止
      if (path === '/emergency-stop' && request.method === 'POST') {
        // TODO: Sprint 2で実装（全running→stopped、フラグ設定）
        return new Response(
          JSON.stringify({ error: '未実装（Sprint 2で実装予定）' }),
          { status: 501, headers: corsHeaders }
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
