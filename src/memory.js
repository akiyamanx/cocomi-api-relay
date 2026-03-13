// このファイルは何をするか:
// COCOMITalkの会議メモリーKV操作モジュール。
// Cloudflare KV（COCOMI_MEMORY）への記憶の読み書き削除と、
// Gemini FlashによるAI要約機能を提供する。
// v1.0 作成 2026-03-11（index.js v1.6から分離）
// v1.1 2026-03-11 - AI要約品質改善（summary/decisions長さチェック、few-shot例追加）
// v1.2 2026-03-11 - マークダウン記法除去＋summary文末完結指示＋プロンプト強化
// v1.3 2026-03-11 - 一括削除（deleteAll）対応追加
// v1.4 2026-03-11 - GET limit上限20→100引き上げ（メモリー管理UI全件表示対応）
// v1.5 2026-03-12 - chat記憶対応（type分岐＋チャット用AI要約プロンプト＋sister/categoryフィールド）
// v1.6 2026-03-13 - GET /memoryにtype/sister/categoryフィルタ追加（スマート取得）

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

// GET /memory — 記憶を取得（フィルタ対応）
// v1.6追加 - クエリパラメータ: type, sister, category でフィルタ可能
// 例: GET /memory?type=chat&sister=koko&limit=3
async function memoryGet(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '5', 10), 100);
  // v1.6追加 - フィルタパラメータ
  const filterType = url.searchParams.get('type') || null;
  const filterSister = url.searchParams.get('sister') || null;
  const filterCategory = url.searchParams.get('category') || null;
  const hasFilter = filterType || filterSister || filterCategory;

  try {
    const indexRaw = await env.COCOMI_MEMORY.get('memories:index');
    const index = indexRaw ? JSON.parse(indexRaw) : [];

    if (!hasFilter) {
      // フィルタなし: 従来通り最新N件（メモリー管理UI等）
      const recentKeys = index.slice(-limit);
      const memories = [];
      for (const key of recentKeys) {
        const raw = await env.COCOMI_MEMORY.get(key);
        if (raw) memories.push(JSON.parse(raw));
      }
      return jsonResponse({ memories, total: index.length });
    }

    // フィルタあり: 新しい方から走査してlimit件集める
    const memories = [];
    for (let i = index.length - 1; i >= 0 && memories.length < limit; i--) {
      const key = index[i];
      // typeフィルタ: キープレフィックスで高速判定（KV読み取り不要）
      if (filterType && !key.startsWith(filterType + ':')) continue;
      const raw = await env.COCOMI_MEMORY.get(key);
      if (!raw) continue;
      const m = JSON.parse(raw);
      // sister/categoryフィルタ
      if (filterSister && m.sister !== filterSister) continue;
      if (filterCategory && m.category !== filterCategory) continue;
      memories.push(m);
    }
    // 古い順に並べ直す（プロンプト注入時に時系列が自然になる）
    memories.reverse();
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

    // v1.5追加 - type指定（chat/meeting）
    const type = body.type || 'meeting';

    let summary = body.summary || '';
    let decisions = body.decisions || [];
    let aiSummary = false;
    let aiError = null;
    // v1.5追加 - AI要約からtopic/categoryを取得する変数
    let aiTopic = null;
    let aiCategory = null;

    // rawHistoryがあればAI要約で高品質な記憶を生成
    if (body.rawHistory && body.rawHistory.length > 0 && env.GEMINI_API_KEY) {
      try {
        const aiResult = await summarizeWithAI(body.topic, body.rawHistory, env, type);
        if (aiResult) {
          // v1.1追加 - AI要約品質チェック
          const validSummary = aiResult.summary && aiResult.summary.length >= 10;
          // v1.2修正 - decisionsからマークダウン記法を除去＋40文字以内にトリム
          let aiDecisions = [];
          if (Array.isArray(aiResult.decisions) && aiResult.decisions.length > 0) {
            aiDecisions = aiResult.decisions
              .filter(d => typeof d === 'string' && d.length > 3)
              .map(d => d
                .replace(/^\s*#{1,6}\s+\d*\.?\s*/g, '')  // ## 見出し
                .replace(/^\s*[-*]+\s+/g, '')  // - リスト / * リスト
                .replace(/\*{1,3}/g, '')  // 残った*を全除去（太字等）
                .replace(/\|[^|]*\|/g, '')  // |テーブル|
                .trim()
                .substring(0, 40))
              .filter(d => d.length > 5);
          }
          const validDecisions = aiDecisions.length > 0;

          // v1.2修正 - summaryの文末を完結させる
          let finalSummary = validSummary ? aiResult.summary.substring(0, 100) : summary;
          if (validSummary && finalSummary.length > 10) {
            const endings = /[。た！だよね]$/;
            if (!endings.test(finalSummary)) {
              // 末尾の助詞・句読点を除去してから「について議論した」で補完
              finalSummary = finalSummary.replace(/[をがはのにやと、]+$/, '');
              if (!endings.test(finalSummary)) {
                finalSummary = finalSummary + 'について議論した';
              }
            }
          }
          summary = finalSummary;
          decisions = validDecisions ? aiDecisions : decisions;
          aiSummary = validSummary; // summaryがAI由来かどうか
          // v1.5追加 - チャット要約のtopic/categoryをAI結果から取得
          if (aiResult.topic) aiTopic = aiResult.topic;
          if (aiResult.category) aiCategory = aiResult.category;
        }
      } catch (e) {
        aiError = e.message;
      }
    } else {
      aiError = `skip: rawHistory=${!!(body.rawHistory)}, len=${body.rawHistory?.length || 0}, key=${!!env.GEMINI_API_KEY}`;
    }

    if (!summary) return jsonError('summary は必須です', 400);

    const timestamp = Date.now();
    const key = `${type}:${timestamp}`;
    const memory = {
      key,
      type,
      topic: aiTopic || body.topic,
      summary,
      decisions,
      // v1.5追加 - チャット記憶用フィールド（meeting時はnull）
      sister: body.sister || null,
      category: aiCategory || body.category || null,
      // 会議記憶用フィールド（chat時は不要だが互換性のため保持）
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

// v1.1改善 - Gemini Flashで内容を要約＋決定事項抽出
// v1.5改善 - type引数追加（chat/meeting分岐）
async function summarizeWithAI(topic, rawHistory, env, type = 'meeting') {
  const historyText = rawHistory
    .map(h => `${h.sister || h.role || '参加者'}: ${h.content}`)
    .join('\n')
    .substring(0, 2000);

  // v1.5追加 - type別プロンプト
  const prompt = type === 'chat'
    ? _buildChatPrompt(historyText)
    : _buildMeetingPrompt(topic, historyText);

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

// v1.5追加 - チャット要約用プロンプト
function _buildChatPrompt(historyText) {
  return `以下の1対1チャット会話を要約してJSON形式で出力してください。
JSON以外は絶対に出力しないでください。前置き文もコードフェンスも不要です。

出力形式の例:
{"summary":"午前中のメンテナンス作業が大変だったという話をした。疲れたけど頑張った","decisions":[],"category":"雑談","topic":"仕事の疲れについて"}

ルール:
- summaryは30〜80文字の日本語。「〜した」「〜について話した」等で文を完結させること
- topicは会話の主題を10〜30文字で要約
- categoryは以下から1つ選択: 開発/雑談/ドライブ/食事/晩酌/仕事/趣味/相談/家族
- decisionsは決まったことがあれば配列で。雑談なら空配列[]
- マークダウン記法は使わない。プレーンテキストのみ
- JSON以外の文字を出力しない

チャット会話:
${historyText}`;
}

// v1.5追加 - 会議要約用プロンプト（従来のプロンプトを関数化）
function _buildMeetingPrompt(topic, historyText) {
  return `会議記録を要約してJSON形式で出力してください。
JSON以外は絶対に出力しないでください。前置き文もコードフェンスも不要です。

出力形式の例:
{"summary":"COCOMITalkの音声機能について議論し、VOICEVOXとOpenAI TTSの2系統で実装する方針に決定した","decisions":["VOICEVOXをメインTTSとして採用","OpenAI TTSをフォールバックに設定","スピード調整UIを追加"]}

ルール:
- summaryは30〜80文字の日本語。「〜した」「〜となった」等で文を完結させること
- decisionsは具体的な決定事項のみ。各30文字以内の配列。決定事項がなければ空配列[]
- マークダウン記法(#,**,|,-等)は使わない。プレーンテキストのみ
- 見出しや箇条書き記号を含めない
- JSON以外の文字を出力しない

議題: ${topic}
会議記録:
${historyText}`;
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

// DELETE /memory — 記憶を削除（1件 or 全件）
// body.action === 'deleteAll' の場合は全件削除
// body.key がある場合は1件削除
async function memoryDelete(request, env) {
  try {
    const body = await request.json();

    // v1.3追加 - 一括削除
    if (body.action === 'deleteAll') {
      const indexRaw = await env.COCOMI_MEMORY.get('memories:index');
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      const count = index.length;
      // 全記憶を削除
      for (const key of index) {
        await env.COCOMI_MEMORY.delete(key);
      }
      // インデックスを空にする
      await env.COCOMI_MEMORY.put('memories:index', JSON.stringify([]));
      return jsonResponse({ success: true, deleted: count });
    }

    // 1件削除（従来の処理）
    if (!body.key) return jsonError('key は必須です', 400);
    await env.COCOMI_MEMORY.delete(body.key);
    const indexRaw = await env.COCOMI_MEMORY.get('memories:index');
    const index = indexRaw ? JSON.parse(indexRaw) : [];
    const newIndex = index.filter(k => k !== body.key);
    await env.COCOMI_MEMORY.put('memories:index', JSON.stringify(newIndex));
    return jsonResponse({ success: true, deleted: body.key });
  } catch (e) {
    return jsonError(`メモリー削除エラー: ${e.message}`, 500);
  }
}
