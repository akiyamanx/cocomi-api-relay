// このファイルは何をするか:
// COCOMI ジャーナリング自律エージェントの玄関（HTTP の入口）。
// リクエストを受けて orchestrator の runJournalAgent を呼び、結果を JSON で返す。
//   - GET  /health  : 疎通確認（合言葉いらない）
//   - POST /journal : 日記テキストを受けて自律エージェントを実行（合言葉が必要）
// 認証は X-COCOMI-AUTH ヘッダ === env.COCOMI_AUTH_TOKEN（relay と同じ作法）。
// MVP は curl 主体のため Origin チェックは必須にせず、合言葉トークンで保護する。
// v1.0 2026-06-22 (Day92) - 初版

'use strict';

import { runJournalAgent } from './orchestrator.js';

export default {
  async fetch(request, env) {
    // CORS プリフライト（ブラウザ用）
    if (request.method === 'OPTIONS') {
      return cors(env, new Response(null, { status: 204 }));
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/+|\/+$/g, '');

      // --- ヘルスチェック（合言葉いらない）---
      if (path === 'health' && request.method === 'GET') {
        return cors(env, json({
          status: 'ok',
          service: 'cocomi-journal-agent',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
        }));
      }

      // --- ここから先は合言葉が必要 ---
      if (!isAuthed(request, env)) {
        return cors(env, jsonErr('Unauthorized', 401));
      }

      // --- 日記の自律処理 ---
      if (path === 'journal' && request.method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch {
          return cors(env, jsonErr('JSON の形式が正しくありません', 400));
        }
        const text = (body && typeof body.text === 'string') ? body.text.trim() : '';
        if (!text) {
          return cors(env, jsonErr('text フィールド（今日の出来事）が必要です', 400));
        }

        // safety-check → 自律ループ → 振り返り＋todo（red の時は受け止めレスポンス）
        const result = await runJournalAgent(env, text);
        // red も含めて 200 で返す（red は crisisResponse を同梱）
        return cors(env, json(result));
      }

      return cors(env, jsonErr(`不明なエンドポイント: /${path}`, 404));
    } catch (err) {
      return cors(env, jsonErr('サーバー内部エラー', 500));
    }
  },
};

// ---- 認証（relay と同じ作法。合言葉が未設定なら必ず弾く＝安全側）----
function isAuthed(request, env) {
  const token = request.headers.get('X-COCOMI-AUTH') || '';
  return Boolean(env.COCOMI_AUTH_TOKEN) && token === env.COCOMI_AUTH_TOKEN;
}

// ---- CORS（relay と同じヘッダ）----
function cors(env, response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-COCOMI-AUTH');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, headers });
}

// ---- JSON ヘルパー ----
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function jsonErr(message, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
