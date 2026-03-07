// このファイルは何をするか:
// COCOMITalkのAPI中継Worker。フロントエンド（GitHub Pages）からのリクエストを受け、
// 各AI APIに安全に転送する。APIキーはWorkerのSecrets（環境変数）で管理。
// v1.0 作成 2026-03-07

// ============================================================
// 定数・設定
// ============================================================

// v1.0 - API転送先URL定義
const API_ENDPOINTS = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  openai: 'https://api.openai.com/v1/chat/completions',
  claude: 'https://api.anthropic.com/v1/messages',
  whisper: 'https://api.openai.com/v1/audio/transcriptions',
};

// v1.0 - リトライ設定（安全ガイド準拠: 最大3回）
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// ============================================================
// メインハンドラー
// ============================================================

export default {
  async fetch(request, env) {
    // v1.0 - OPTIONSプリフライト対応
    if (request.method === 'OPTIONS') {
      return handleCORS(env, new Response(null, { status: 204 }));
    }

    try {
      // v1.0 - パスによるルーティング
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/+|\/+$/g, '');

      // v1.1修正 - ヘルスチェック（認証もCORSも不要 - どこからでもアクセス可能）
      if (path === 'health' && request.method === 'GET') {
        return handleCORS(env, jsonResponse({
          status: 'ok',
          service: 'cocomi-api-relay',
          version: '1.1',
          timestamp: new Date().toISOString(),
        }));
      }

      // v1.0 - CORS検証（health以外）
      const origin = request.headers.get('Origin') || '';
      if (!isAllowedOrigin(origin, env)) {
        return jsonError('Forbidden: Origin not allowed', 403);
      }

      // v1.0 - 認証チェック（ヘルスチェック以外は必須）
      if (!isAuthenticated(request, env)) {
        return handleCORS(env, jsonError('Unauthorized', 401));
      }

      // v1.0 - POSTメソッドのみ許可（API中継）
      if (request.method !== 'POST') {
        return handleCORS(env, jsonError('Method not allowed', 405));
      }

      // v1.0 - エンドポイントルーティング
      let response;
      switch (path) {
        case 'gemini':
          response = await relayGemini(request, env);
          break;
        case 'openai':
          response = await relayOpenAI(request, env);
          break;
        case 'claude':
          response = await relayClaude(request, env);
          break;
        case 'whisper':
          response = await relayWhisper(request, env);
          break;
        default:
          response = jsonError(`Unknown endpoint: /${path}`, 404);
      }

      return handleCORS(env, response);
    } catch (err) {
      console.error('Worker error:', err.message, err.stack);
      return handleCORS(env, jsonError('Internal server error', 500));
    }
  },
};

// ============================================================
// API中継関数
// ============================================================

// v1.0 - Gemini API中継（ここちゃん）
// フロントから { model, contents, systemInstruction, generationConfig, safetySettings } を受け取り、
// APIキーだけWorker側で付与して転送する
async function relayGemini(request, env) {
  const body = await request.json();

  // モデル名を取り出し（フロント側でフルネームを送る想定）
  const model = body.model || 'gemini-2.5-flash';
  const action = body.action || 'generateContent';
  const apiUrl = `${API_ENDPOINTS.gemini}/models/${model}:${action}?key=${env.GEMINI_API_KEY}`;

  // Gemini APIに転送するペイロード（model, actionはURL側で使うので除外）
  const payload = { ...body };
  delete payload.model;
  delete payload.action;

  const apiResponse = await fetchWithRetry(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await apiResponse.json();
  return jsonResponse(data, apiResponse.status);
}

// v1.0 - OpenAI API中継（お姉ちゃん / GPT）
async function relayOpenAI(request, env) {
  const body = await request.json();

  const apiResponse = await fetchWithRetry(API_ENDPOINTS.openai, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const data = await apiResponse.json();
  return jsonResponse(data, apiResponse.status);
}

// v1.0 - Claude API中継（クロちゃん）
async function relayClaude(request, env) {
  const body = await request.json();

  const apiResponse = await fetchWithRetry(API_ENDPOINTS.claude, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const data = await apiResponse.json();
  return jsonResponse(data, apiResponse.status);
}

// v1.0 - Whisper API中継（音声認識）
async function relayWhisper(request, env) {
  // Whisperはmultipart/form-dataで受け取る
  const contentType = request.headers.get('Content-Type') || '';

  let formData;
  if (contentType.includes('multipart/form-data')) {
    // フロントからFormDataをそのまま受け取る
    formData = await request.formData();
  } else {
    return jsonError('Whisper endpoint requires multipart/form-data', 400);
  }

  // languageが指定されてなければ日本語デフォルト
  if (!formData.get('language')) {
    formData.set('language', 'ja');
  }
  // モデル指定がなければwhisper-1
  if (!formData.get('model')) {
    formData.set('model', 'whisper-1');
  }

  const apiResponse = await fetchWithRetry(API_ENDPOINTS.whisper, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      // Content-Typeはfetch側で自動設定（multipart/form-data + boundary）
    },
    body: formData,
  });

  const data = await apiResponse.json();
  return jsonResponse(data, apiResponse.status);
}

// ============================================================
// セキュリティ・ユーティリティ
// ============================================================

// v1.0 - CORS許可Origin判定
function isAllowedOrigin(origin, env) {
  const allowed = env.ALLOWED_ORIGIN || 'https://akiyamanx.github.io';
  // 開発時はlocalhostも許可
  if (origin === allowed) return true;
  if (origin.startsWith('http://localhost:')) return true;
  if (origin.startsWith('http://127.0.0.1:')) return true;
  return false;
}

// v1.0 - 認証トークン検証
function isAuthenticated(request, env) {
  const token = request.headers.get('X-COCOMI-AUTH') || '';
  return token === env.COCOMI_AUTH_TOKEN;
}

// v1.0 - CORSヘッダー付与
function handleCORS(env, response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-COCOMI-AUTH');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

// v1.0 - JSONレスポンス生成
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// v1.0 - JSONエラーレスポンス
function jsonError(message, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// v1.0 - リトライ付きfetch（安全ガイド準拠: 最大3回、指数バックオフ）
async function fetchWithRetry(url, options) {
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
