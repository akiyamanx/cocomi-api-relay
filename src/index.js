// このファイルは何をするか:
// COCOMITalkのAPI中継Worker。フロントエンド（GitHub Pages）からのリクエストを受け、
// 各AI APIに安全に転送する。APIキーはWorkerのSecrets（環境変数）で管理。
// v1.0 作成 2026-03-07
// v1.2 2026-03-09 - /tts-test エンドポイント追加（OpenAI TTS音声生成）
// v1.3 2026-03-10 - Step 4 /memory エンドポイント追加（Cloudflare KVメモリー）
// v1.4 2026-03-10 - Step 4強化: AI要約による記憶品質向上（Gemini Flash使用）
// v1.5 2026-03-10 - AI要約JSON抽出修正（indexOf/lastIndexOf方式）

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
          version: '1.6',
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

// ============================================================
// v1.3追加 - メモリーKV操作（Step 4: 会議メモリー）
// KV名前空間: COCOMI_MEMORY（wrangler.tomlでバインド）
// キー設計: "meeting:{timestamp}" = 会議記憶1件
//           "memories:index" = 全記憶のキー一覧（配列JSON）
// ============================================================

// メモリーエンドポイントハンドラー（GET/POST/DELETE分岐）
async function handleMemory(request, env) {
  if (!env.COCOMI_MEMORY) {
    return jsonError('KV namespace COCOMI_MEMORY が未設定です', 500);
  }
  const method = request.method;
  if (method === 'GET') return memoryGet(request, env);
  if (method === 'POST') return memorySave(request, env);
  if (method === 'DELETE') return memoryDelete(request, env);
  return jsonError('Method not allowed for /memory', 405);
}

// GET /memory — 最新N件の記憶を取得
async function memoryGet(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '5', 10), 20);
  try {
    // インデックスから記憶キー一覧を取得
    const indexRaw = await env.COCOMI_MEMORY.get('memories:index');
    const index = indexRaw ? JSON.parse(indexRaw) : [];
    // 最新N件のキーを取得
    const recentKeys = index.slice(-limit);
    // 各記憶の本体を取得
    const memories = [];
    for (const key of recentKeys) {
      const raw = await env.COCOMI_MEMORY.get(key);
      if (raw) memories.push(JSON.parse(raw));
    }
    return jsonResponse({ memories, total: index.length });
  } catch (e) {
    return jsonError(`メモリー取得エラー: ${e.message}`, 500);
  }
}

// POST /memory — 記憶を1件保存
// v1.4追加: rawHistoryがあればGemini FlashでAI要約を生成してから保存
async function memorySave(request, env) {
  try {
    const body = await request.json();
    if (!body.topic) return jsonError('topic は必須です', 400);

    let summary = body.summary || '';
    let decisions = body.decisions || [];
    let aiSummary = false;
    let aiError = null;

    // v1.4追加 - rawHistoryがあればAI要約で高品質な記憶を生成
    if (body.rawHistory && body.rawHistory.length > 0 && env.GEMINI_API_KEY) {
      try {
        const aiResult = await summarizeWithAI(body.topic, body.rawHistory, env);
        if (aiResult) {
          summary = aiResult.summary || summary;
          decisions = aiResult.decisions || decisions;
          aiSummary = true;
        }
      } catch (e) {
        aiError = e.message;
      }
    } else {
      aiError = `skip: rawHistory=${!!(body.rawHistory)}, len=${body.rawHistory?.length || 0}, key=${!!env.GEMINI_API_KEY}`;
    }

    if (!summary) return jsonError('summary は必須です', 400);

    const timestamp = Date.now();
    const key = `meeting:${timestamp}`;
    const memory = {
      key,
      topic: body.topic,
      summary,
      decisions,
      round: body.round || 1,
      lead: body.lead || null,
      mood: body.mood || 'neutral',
      aiSummary,
      aiError,
      createdAt: new Date(timestamp).toISOString(),
    };
    await env.COCOMI_MEMORY.put(key, JSON.stringify(memory));
    const indexRaw = await env.COCOMI_MEMORY.get('memories:index');
    const index = indexRaw ? JSON.parse(indexRaw) : [];
    index.push(key);
    while (index.length > 100) {
      const oldKey = index.shift();
      await env.COCOMI_MEMORY.delete(oldKey);
    }
    await env.COCOMI_MEMORY.put('memories:index', JSON.stringify(index));
    return jsonResponse({ success: true, key, memory });
  } catch (e) {
    return jsonError(`メモリー保存エラー: ${e.message}`, 500);
  }
}

// v1.5修正 - Gemini Flashで会議内容を要約＋決定事項抽出
// maxOutputTokens:512に増加、summary50文字以内に短縮、不完全JSON補完対応
async function summarizeWithAI(topic, rawHistory, env) {
  const historyText = rawHistory
    .map(h => `${h.sister || '参加者'}: ${h.content}`)
    .join('\n')
    .substring(0, 2000);

  const prompt = `会議記録の要約をJSON形式で出力。JSON以外は出力禁止。

議題: ${topic}
会議記録:
${historyText}

出力（JSONのみ。summaryは50文字以内。decisionsは各30文字以内）:
{"summary":"50文字以内の要約","decisions":["決定事項"]}`;

  const apiUrl = `${API_ENDPOINTS.gemini}/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 512, temperature: 0.1 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini API ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('AI応答が空');
  // ① 直接パース
  try { return JSON.parse(text.trim()); } catch (_) {}
  // ② フェンス除去してパース
  const clean = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(clean); } catch (_) {}
  // ③ {から}まで切り出し
  const fi = clean.indexOf('{');
  const li = clean.lastIndexOf('}');
  if (fi !== -1 && li > fi) {
    try { return JSON.parse(clean.substring(fi, li + 1)); } catch (_) {}
  }
  // ④ JSON途中切れ補完（maxTokens不足対策）
  if (fi !== -1) {
    const p = clean.substring(fi);
    try { return JSON.parse(p + '"}]}'); } catch (_) {}
    try { return JSON.parse(p + '"]}'); } catch (_) {}
    try { return JSON.parse(p + '"}'); } catch (_) {}
  }
  throw new Error('JSON抽出失敗: ' + text.substring(0, 150));
}

// DELETE /memory — 記憶を1件削除（bodyにkeyを指定）
async function memoryDelete(request, env) {
  try {
    const body = await request.json();
    if (!body.key) return jsonError('key は必須です', 400);
    // KVから削除
    await env.COCOMI_MEMORY.delete(body.key);
    // インデックスからも除去
    const indexRaw = await env.COCOMI_MEMORY.get('memories:index');
    const index = indexRaw ? JSON.parse(indexRaw) : [];
    const newIndex = index.filter(k => k !== body.key);
    await env.COCOMI_MEMORY.put('memories:index', JSON.stringify(newIndex));
    return jsonResponse({ success: true, deleted: body.key });
  } catch (e) {
    return jsonError(`メモリー削除エラー: ${e.message}`, 500);
  }
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
