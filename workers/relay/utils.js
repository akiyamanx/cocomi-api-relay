// このファイルは何をするか:
// cocomi-api-relay Workerの共通ユーティリティ関数。
// JSON応答生成、エラー応答、CORS処理、認証チェック、リトライfetchを提供する。
// v1.0 作成 2026-03-11（index.js v1.6から分離）

// ============================================================
// リトライ設定（安全ガイド準拠: 最大3回）
// ============================================================
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// ============================================================
// CORS・認証
// ============================================================

// CORS許可Origin判定
export function isAllowedOrigin(origin, env) {
  const allowed = env.ALLOWED_ORIGIN || 'https://akiyamanx.github.io';
  // 開発時はlocalhostも許可
  if (origin === allowed) return true;
  if (origin.startsWith('http://localhost:')) return true;
  if (origin.startsWith('http://127.0.0.1:')) return true;
  return false;
}

// 認証トークン検証
export function isAuthenticated(request, env) {
  const token = request.headers.get('X-COCOMI-AUTH') || '';
  return token === env.COCOMI_AUTH_TOKEN;
}

// CORSヘッダー付与
export function handleCORS(env, response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-COCOMI-AUTH');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

// ============================================================
// レスポンス生成
// ============================================================

// JSONレスポンス生成
export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// JSONエラーレスポンス
export function jsonError(message, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================
// リトライ付きfetch（安全ガイド準拠: 最大3回、指数バックオフ）
// ============================================================
export async function fetchWithRetry(url, options) {
  let lastError;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const response = await fetch(url, options);
      // 429（レート制限）または5xx系はリトライ対象
      if (response.status === 429 || response.status >= 500) {
        if (i < MAX_RETRIES - 1) {
          const waitMs = RETRY_BASE_MS * Math.pow(2, i);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
      }
      return response;
    } catch (err) {
      lastError = err;
      if (i < MAX_RETRIES - 1) {
        const waitMs = RETRY_BASE_MS * Math.pow(2, i);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  // 全リトライ失敗
  throw lastError || new Error('All retries failed');
}
