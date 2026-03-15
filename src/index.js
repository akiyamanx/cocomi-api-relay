// このファイルは何をするか:
// COCOMITalkのAPI中継Worker。フロントエンド（GitHub Pages）からのリクエストを受け、
// 各AI APIに安全に転送する。APIキーはWorkerのSecrets（環境変数）で管理。
// v1.0 作成 2026-03-07
// v1.2 2026-03-09 - /tts-test エンドポイント追加（OpenAI TTS音声生成）
// v1.3 2026-03-10 - Step 4 /memory エンドポイント追加（Cloudflare KVメモリー）
// v1.4 2026-03-10 - Step 4強化: AI要約による記憶品質向上（Gemini Flash使用）
// v1.5 2026-03-10 - AI要約JSON抽出修正（indexOf/lastIndexOf方式）
// v1.6 2026-03-10 - maxTokens 512 + summary 50chars + incomplete JSON recovery
// v1.7 2026-03-11 - モジュール分割（memory.js, utils.js分離）+ AI要約品質改善
// v1.8 2026-03-12 - Phase 2a リアルタイム検索（search.js追加、/searchエンドポイント）
// v1.9 2026-03-13 - Step 6 Phase 2: D1移行（/memory-migrateエンドポイント追加）
// v2.0 2026-03-13 - クリーンアップ: /memory-migrate削除（移行完了済み）
// v2.1 2026-03-15 - Step 6 Phase 2: /memory-search + /memory-vectorize エンドポイント追加
// v2.2 2026-03-15 - memory.js v1.11: 感情の温度記憶対応

// ============================================================
// モジュールインポート
// ============================================================
import { handleMemory } from './memory.js';
import { _rowToMemory } from './memory.js';
import { handleMemorySearch, handleVectorizeMigration } from './vector.js';
import { handleSearch } from './search.js';
import {
  isAllowedOrigin, isAuthenticated, handleCORS,
  jsonResponse, jsonError, fetchWithRetry
} from './utils.js';

// ============================================================
// 定数・設定
// ============================================================

// v1.0 - API転送先URL定義
const API_ENDPOINTS = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  openai: 'https://api.openai.com/v1/chat/completions',
  claude: 'https://api.anthropic.com/v1/messages',
  whisper: 'https://api.openai.com/v1/audio/transcriptions',
  tts: 'https://api.openai.com/v1/audio/speech', // v1.2追加
};

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
          version: '2.2',
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

      // v1.3追加 - /memory はGET/POST/DELETE対応（POST制限の前に分岐）
      if (path === 'memory') {
        const memRes = await handleMemory(request, env);
        return handleCORS(env, memRes);
      }

      // v2.1追加 - /memory-search はPOST対応（Step 6 Phase 2: Vectorize RAG意味検索）
      if (path === 'memory-search' && request.method === 'POST') {
        const searchRes = await handleMemorySearch(request, env, _rowToMemory);
        return handleCORS(env, searchRes);
      }

      // v2.1追加 - /memory-vectorize はPOST対応（既存記憶のembedding一括生成・一時エンドポイント）
      if (path === 'memory-vectorize' && request.method === 'POST') {
        const migrateRes = await handleVectorizeMigration(request, env);
        return handleCORS(env, migrateRes);
      }

      // v1.8追加 - /search はPOST対応（Phase 2a リアルタイム検索）
      if (path === 'search') {
        if (request.method !== 'POST') {
          return handleCORS(env, jsonError('Method not allowed for /search', 405));
        }
        const searchRes = await handleSearch(request, env);
        return handleCORS(env, searchRes);
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
        case 'tts-test': // v1.2追加 - TTS声テスト
        case 'tts':      // v1.2追加 - TTS本番用（同じ処理）
          response = await relayTTS(request, env);
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

// v1.2追加 - OpenAI TTS API中継（テキスト→音声変換）
// リクエスト: { text, voice, speed, model }
// レスポンス: audio/mpeg（mp3バイナリ）
async function relayTTS(request, env) {
  const body = await request.json();

  // バリデーション
  const allowedVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
  const text = (body.text || '').trim();
  const voice = body.voice || 'alloy';
  const speed = Number(body.speed) || 1.0;
  const model = body.model || 'tts-1';

  if (!text) return jsonError('text は必須です', 400);
  if (text.length > 500) return jsonError('text は500文字以内にしてください', 400);
  if (!allowedVoices.includes(voice)) {
    return jsonError(`voice は ${allowedVoices.join(', ')} のいずれかです`, 400);
  }
  if (speed < 0.25 || speed > 4.0) return jsonError('speed は 0.25〜4.0 の範囲です', 400);

  // OpenAI TTS APIに転送
  const apiResponse = await fetchWithRetry(API_ENDPOINTS.tts, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model, input: text, voice, speed, response_format: 'mp3' }),
  });

  // 音声バイナリをそのまま返す
  if (!apiResponse.ok) {
    const errData = await apiResponse.json().catch(() => ({}));
    return jsonError(errData.error?.message || 'TTS API error', apiResponse.status);
  }

  return new Response(apiResponse.body, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' },
  });
}
