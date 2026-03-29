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
// v2.3 2026-03-15 - memory.js v1.12: JSON出力強制（感情フィールドnull修正）
// v2.4 2026-03-16 - memory.js v1.15: デバッグコード削除（感情温度動作確認済み）
// v2.5 2026-03-16 - import.js v1.0: 記憶直接投入エンドポイント（/memory-import）追加
// v2.6 2026-03-19 - relayWhisper: FormData中継時のcontent-type再構築（Invalid file format対策）
// v2.7 2026-03-24 - ストリーミング中継対応（OpenAI/Claude、stream:trueで30秒タイムアウト回避）
// v2.8 2026-03-27 - クリーンアップ: /memory-vectorize一時エンドポイント削除（完了済み）
// v2.9 2026-03-27 - HOTトピック通知: /memory-recent エンドポイント追加（直近24h以内の新着記憶取得）
// v3.0 2026-03-28 - 相談トピック連携: /consultation エンドポイント追加（claude.ai↔COCOMITalk会議室）
// v3.1 2026-03-30 - Sprint 1代弁問題応急処置: /memory-recentにsisterカラム追加

import { handleMemory } from './memory.js';
import { _rowToMemory } from './memory.js';
import { handleMemorySearch } from './vector.js';
import { handleSearch } from './search.js';
import { handleMemoryImport } from './import.js';
// v3.0追加 - 相談トピック連携
import { handleGetConsultation, handlePostConsultation, handleResolveConsultation } from './consultation.js';
import {
  isAllowedOrigin, isAuthenticated, handleCORS,
  jsonResponse, jsonError, fetchWithRetry
} from './utils.js';

const API_ENDPOINTS = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  openai: 'https://api.openai.com/v1/chat/completions',
  claude: 'https://api.anthropic.com/v1/messages',
  whisper: 'https://api.openai.com/v1/audio/transcriptions',
  tts: 'https://api.openai.com/v1/audio/speech',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return handleCORS(env, new Response(null, { status: 204 }));
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/+|\/+$/g, '');

      if (path === 'health' && request.method === 'GET') {
        return handleCORS(env, jsonResponse({
          status: 'ok',
          service: 'cocomi-api-relay',
          version: '3.1',
          timestamp: new Date().toISOString(),
        }));
      }

      const origin = request.headers.get('Origin') || '';
      if (!isAllowedOrigin(origin, env)) {
        return jsonError('Forbidden: Origin not allowed', 403);
      }

      if (!isAuthenticated(request, env)) {
        return handleCORS(env, jsonError('Unauthorized', 401));
      }

      // agent-hub プロキシ
      if (url.pathname.startsWith('/agent/')) {
        const agentPath = url.pathname.replace(/^\/agent/, '');
        const agentHeaders = new Headers(request.headers);
        agentHeaders.set('X-Agent-Auth-Token', env.AGENT_AUTH_TOKEN);
        agentHeaders.delete('X-COCOMI-AUTH');
        const agentResponse = await env.AGENT_HUB.fetch(new Request('https://agent-hub' + agentPath + url.search, {
          method: request.method,
          headers: agentHeaders,
          body: ['GET', 'HEAD'].includes(request.method) ? null : request.body
        }));
        const responseHeaders = new Headers(agentResponse.headers);
        responseHeaders.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || 'https://akiyamanx.github.io');
        return new Response(agentResponse.body, {
          status: agentResponse.status,
          headers: responseHeaders
        });
      }

      if (path === 'memory') {
        const memRes = await handleMemory(request, env);
        return handleCORS(env, memRes);
      }

      if (path === 'memory-import' && request.method === 'POST') {
        const importRes = await handleMemoryImport(request, env);
        return handleCORS(env, importRes);
      }

      if (path === 'memory-search' && request.method === 'POST') {
        const searchRes = await handleMemorySearch(request, env, _rowToMemory);
        return handleCORS(env, searchRes);
      }

      // v2.9追加 - HOTトピック通知用: 直近の新着記憶を取得
      if (path === 'memory-recent' && request.method === 'GET') {
        const recentRes = await handleMemoryRecent(url, env);
        return handleCORS(env, recentRes);
      }

      // v3.0追加 - 相談トピック連携
      // GET /consultation?status=pending — 未回答の相談トピックを取得（COCOMITalk会議画面用）
      // POST /consultation — 新しい相談を書き込む（claude.aiクロちゃん or MCP経由）
      if (path === 'consultation') {
        if (request.method === 'GET') {
          const conRes = await handleGetConsultation(url, env);
          return handleCORS(env, conRes);
        }
        if (request.method === 'POST') {
          const conRes = await handlePostConsultation(request, env);
          return handleCORS(env, conRes);
        }
        return handleCORS(env, jsonError('Method not allowed for /consultation', 405));
      }

      // v3.0追加 - 相談トピック回答書き戻し
      // POST /consultation/resolve — 会議結果をDBに保存（アキヤが「DL＋DB保存」選択時のみ）
      if (path === 'consultation/resolve' && request.method === 'POST') {
        const resolveRes = await handleResolveConsultation(request, env);
        return handleCORS(env, resolveRes);
      }

      if (path === 'search') {
        if (request.method !== 'POST') {
          return handleCORS(env, jsonError('Method not allowed for /search', 405));
        }
        const searchRes = await handleSearch(request, env);
        return handleCORS(env, searchRes);
      }

      if (request.method !== 'POST') {
        return handleCORS(env, jsonError('Method not allowed', 405));
      }

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
        case 'tts-test':
        case 'tts':
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

// v2.9追加 - HOTトピック通知用: 直近の新着記憶を取得
// v3.1更新 - sisterカラム追加（代弁問題Sprint 1: 誰の記憶かをフロントで表示するため）
async function handleMemoryRecent(url, env) {
  try {
    const hours = Math.min(Math.max(parseInt(url.searchParams.get('hours')) || 24, 1), 168);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 5, 1), 10);

    // v3.1変更 - sisterカラムを追加（代弁禁止テンプレートで「誰の記憶か」を表示するため）
    const sql = `
      SELECT topic, summary, emotion_user, emotion_ai, emotion_comment, sister, created_at, source
      FROM memories
      WHERE created_at > datetime('now', '-${hours} hours')
      ORDER BY created_at DESC
      LIMIT ?
    `;

    const stmt = env.DB.prepare(sql).bind(limit);
    const { results } = await stmt.all();

    return jsonResponse({
      memories: results || [],
      count: (results || []).length,
      hours,
      limit,
    });
  } catch (e) {
    console.error('[memory-recent] エラー:', e.message);
    return jsonError(`memory-recent エラー: ${e.message}`, 500);
  }
}

async function relayGemini(request, env) {
  const body = await request.json();
  const model = body.model || 'gemini-2.5-flash';
  const action = body.action || 'generateContent';
  const apiUrl = `${API_ENDPOINTS.gemini}/models/${model}:${action}?key=${env.GEMINI_API_KEY}`;
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

async function relayOpenAI(request, env) {
  const body = await request.json();
  if (body.stream === true) {
    return relayStreamOpenAI(body, env);
  }
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

async function relayClaude(request, env) {
  const body = await request.json();
  if (body.stream === true) {
    return relayStreamClaude(body, env);
  }
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

async function relayWhisper(request, env) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return jsonError('Whisper endpoint requires multipart/form-data', 400);
  }
  const incomingForm = await request.formData();
  const file = incomingForm.get('file');
  if (!file) {
    return jsonError('Whisper endpoint requires file field', 400);
  }
  const MIME_MAP = {
    webm: 'audio/webm', mp3: 'audio/mpeg', mp4: 'audio/mp4',
    m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg',
    flac: 'audio/flac', wav: 'audio/wav',
  };
  const fileName = file.name || 'audio.webm';
  const ext = fileName.split('.').pop().toLowerCase();
  const correctMime = MIME_MAP[ext] || 'audio/webm';
  const arrayBuf = await file.arrayBuffer();
  const correctedBlob = new Blob([arrayBuf], { type: correctMime });
  const newForm = new FormData();
  newForm.append('file', correctedBlob, fileName);
  newForm.append('model', incomingForm.get('model') || 'whisper-1');
  newForm.append('language', incomingForm.get('language') || 'ja');
  const prompt = incomingForm.get('prompt');
  if (prompt) {
    newForm.append('prompt', prompt);
  }
  const apiResponse = await fetchWithRetry(API_ENDPOINTS.whisper, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: newForm,
  });
  const data = await apiResponse.json();
  return jsonResponse(data, apiResponse.status);
}

async function relayStreamOpenAI(body, env) {
  const apiResponse = await fetch(API_ENDPOINTS.openai, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!apiResponse.ok) {
    const errData = await apiResponse.json().catch(() => ({}));
    return jsonError(errData?.error?.message || `OpenAI stream error: ${apiResponse.status}`, apiResponse.status);
  }
  return new Response(apiResponse.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

async function relayStreamClaude(body, env) {
  const apiResponse = await fetch(API_ENDPOINTS.claude, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!apiResponse.ok) {
    const errData = await apiResponse.json().catch(() => ({}));
    return jsonError(errData?.error?.message || `Claude stream error: ${apiResponse.status}`, apiResponse.status);
  }
  return new Response(apiResponse.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

async function relayTTS(request, env) {
  const body = await request.json();
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
  const apiResponse = await fetchWithRetry(API_ENDPOINTS.tts, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model, input: text, voice, speed, response_format: 'mp3' }),
  });
  if (!apiResponse.ok) {
    const errData = await apiResponse.json().catch(() => ({}));
    return jsonError(errData.error?.message || 'TTS API error', apiResponse.status);
  }
  return new Response(apiResponse.body, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' },
  });
}