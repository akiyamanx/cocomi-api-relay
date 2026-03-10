// このファイルは何をするか:
// COCOMITalkの会議メモリーKV操作モジュール。
// Cloudflare KV（COCOMI_MEMORY）への記憶の読み書き削除と、
// Gemini FlashによるAI要約機能を提供する。
// v1.0 作成 2026-03-11（index.js v1.6から分離）
// v1.1 2026-03-11 - AI要約品質改善（summary/decisions長さチェック、few-shot例追加）

import { jsonResponse, jsonError } from './utils.js';

// ============================================================
// Gemini API設定（AI要約用）
// ============================================================

// v1.0 - Gemini APIエンドポイント
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// ============================================================
// メモリーKV操作（Step 4: 会議メモリー）
// KV名前空間: COCOMI_MEMORY（wrangler.tomlでバインド）
// キー設計: "meeting:{timestamp}" = 会議記憶1件
//           "memories:index" = 全記憶のキー一覧（配列JSON）
// ============================================================

// メモリーエンドポイントハンドラー（GET/POST/DELETE分岐）
export async function handleMemory(request, env) {
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
// rawHistoryがあればGemini FlashでAI要約を生成してから保存
export async function memorySave(request, env) {
  try {
    const body = await request.json();
    if (!body.topic) return jsonError('topic は必須です', 400);

    let summary = body.summary || '';
    let decisions = body.decisions || [];
    let aiSummary = false;
    let aiError = null;

    // rawHistoryがあればAI要約で高品質な記憶を生成
    if (body.rawHistory && body.rawHistory.length > 0 && env.GEMINI_API_KEY) {
      try {
        const aiResult = await summarizeWithAI(body.topic, body.rawHistory, env);
        if (aiResult) {
          // v1.1追加 - AI要約品質チェック
          const validSummary = aiResult.summary && aiResult.summary.length >= 10;
          const validDecisions = Array.isArray(aiResult.decisions)
            && aiResult.decisions.length > 0
            && aiResult.decisions.every(d => typeof d === 'string' && d.length <= 50);

          summary = validSummary ? aiResult.summary : summary;
          decisions = validDecisions ? aiResult.decisions : decisions;
          aiSummary = validSummary; // summaryがAI由来かどうか
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

    // インデックス管理（最大100件）
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

// v1.1改善 - Gemini Flashで会議内容を要約＋決定事項抽出
// few-shot例追加、summary30〜80文字指示、decisions各30文字以内
async function summarizeWithAI(topic, rawHistory, env) {
  const historyText = rawHistory
    .map(h => `${h.sister || '参加者'}: ${h.content}`)
    .join('\n')
    .substring(0, 2000);

  // v1.1改善 - few-shot例を追加してJSON出力を安定化
  const prompt = `会議記録を要約してJSON形式で出力してください。
JSON以外は絶対に出力しないでください。前置き文もコードフェンスも不要です。

出力形式の例:
{"summary":"COCOMITalkの音声機能について議論し、VOICEVOXとOpenAI TTSの2系統で実装する方針に決定した","decisions":["VOICEVOXをメインTTSとして採用","OpenAI TTSをフォールバックに設定","スピード調整UIを追加"]}

ルール:
- summaryは30〜80文字の日本語で、議題と結論を含める
- decisionsは各30文字以内の配列。決定事項がなければ空配列[]
- JSON以外の文字を出力しない

議題: ${topic}
会議記録:
${historyText}`;

  const apiUrl = `${GEMINI_API_BASE}/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
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

  // 6段階JSON抽出
  return extractJSON(text);
}

// v1.1追加 - 堅牢なJSON抽出（6段階フォールバック）
function extractJSON(text) {
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
