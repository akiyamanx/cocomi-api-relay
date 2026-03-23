// このファイルは何をするか:
// COCOMITalkの記憶直接投入モジュール。クロちゃんとの開発セッションで得た知識・決定事項を
// 三姉妹APIを経由せずにD1＋Vectorizeに直接投入する。
// Termux curlや設定画面UIから呼び出される。
// v1.0 2026-03-16 - 新規作成（実行計画書v24.0「次のステップ#1」）
// v1.1 2026-03-16 - Vectorize用短縮要約生成（Gemini Flash）追加。全文はD1に、要約でembedding
// v1.2 2026-03-17 - 重複チェック追加。Vectorize類似度検索で既存記憶と高類似度ならスキップ
// v1.3 2026-03-23 - sourceカラム対応（保存元区別: importデフォルト / JSONで指定可）
// v1.4 2026-03-23 - 姉妹IDマッピング統一（gpt→onee, claude→kuro）

import { jsonResponse, jsonError } from './utils.js';
import { upsertVector, searchVectors } from './vector.js';

// ============================================================
// 定数
// ============================================================

// 1回の一括投入で許可する最大件数（コスト安全策: embedding生成がAPI課金）
const MAX_BATCH_SIZE = 20;
// MAX_MEMORIESはmemory.jsと同じ値（D1全体の上限）
const MAX_MEMORIES = 100;
// v1.1追加 - 短縮要約の閾値（この文字数を超えたらGemini Flashで要約してからembedding）
const SUMMARY_SHORT_THRESHOLD = 200;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// v1.2追加 - 重複チェック閾値（この類似度スコア以上なら重複とみなす）
const DUPLICATE_THRESHOLD = 0.85;

// ============================================================
// メインハンドラー: POST /memory-import
// ============================================================

/**
 * 記憶直接投入エンドポイント
 *
 * ■ 1件投入:
 *   POST { topic, summary, type?, sister?, category?, decisions?, emotion_user?, emotion_ai?, emotion_comment? }
 *
 * ■ 一括投入:
 *   POST { memories: [ {topic, summary, ...}, {topic, summary, ...}, ... ] }
 *
 * AI要約はスキップ（裏から入れるデータは既にまとまっている前提）
 * Vectorize embeddingは生成する（意味検索に乗せるため）
 */
export async function handleMemoryImport(request, env) {
  if (!env.DB) {
    return jsonError('D1 database DB が未設定です', 500);
  }
  if (request.method !== 'POST') {
    return jsonError('Method not allowed for /memory-import', 405);
  }

  try {
    const body = await request.json();

    // 一括投入モード
    if (Array.isArray(body.memories)) {
      return _importBatch(body.memories, env);
    }

    // 1件投入モード
    if (body.topic && body.summary) {
      return _importSingle(body, env);
    }

    return jsonError('topic+summary（1件）または memories配列（一括）が必要です', 400);
  } catch (e) {
    return jsonError(`記憶インポートエラー: ${e.message}`, 500);
  }
}

// ============================================================
// 1件投入
// ============================================================

async function _importSingle(data, env) {
  const result = await _insertOne(data, env);
  if (result.error) {
    return jsonError(result.error, 400);
  }
  return jsonResponse({ success: true, imported: 1, keys: [result.key] });
}

// ============================================================
// 一括投入
// ============================================================

async function _importBatch(memories, env) {
  if (!Array.isArray(memories) || memories.length === 0) {
    return jsonError('memories配列が空です', 400);
  }
  if (memories.length > MAX_BATCH_SIZE) {
    return jsonError(`一括投入は最大${MAX_BATCH_SIZE}件までです（コスト安全策）`, 400);
  }

  const results = { imported: 0, errors: 0, skipped: 0, keys: [], errorDetails: [] };

  for (const item of memories) {
    const result = await _insertOne(item, env);
    if (result.error) {
      if (result.skipped) {
        results.skipped++;
        results.errorDetails.push(result.error);
      } else {
        results.errors++;
        results.errorDetails.push(result.error);
      }
    } else {
      results.imported++;
      results.keys.push(result.key);
    }
  }

  return jsonResponse({
    success: results.imported > 0,
    imported: results.imported,
    skipped: results.skipped,
    errors: results.errors,
    keys: results.keys,
    errorDetails: results.errorDetails.length > 0 ? results.errorDetails : undefined,
  });
}

// ============================================================
// 共通: 1件のD1挿入 + Vectorize embedding生成
// ============================================================

async function _insertOne(data, env) {
  // バリデーション
  const topic = (data.topic || '').trim();
  const summary = (data.summary || '').trim();
  if (!topic) return { error: 'topicが空です' };
  if (!summary) return { error: 'summaryが空です' };

  const type = data.type || 'import';
  // v1.4追加 - 姉妹IDマッピング（gpt→onee, claude→kuro に統一）
  const SISTER_ID_MAP = { gpt: 'onee', claude: 'kuro', koko: 'koko' };
  const rawSister = data.sister || null;
  const sister = rawSister ? (SISTER_ID_MAP[rawSister] || rawSister) : null;
  const category = data.category || null;
  const decisions = Array.isArray(data.decisions) ? data.decisions : [];

  // 感情の温度（任意）
  let emotionUser = null;
  let emotionAi = null;
  let emotionComment = null;
  const euRaw = Number(data.emotion_user);
  if (!isNaN(euRaw) && euRaw >= 1 && euRaw <= 5) emotionUser = Math.round(euRaw);
  const eaRaw = Number(data.emotion_ai);
  if (!isNaN(eaRaw) && eaRaw >= 1 && eaRaw <= 5) emotionAi = Math.round(eaRaw);
  if (data.emotion_comment) {
    emotionComment = String(data.emotion_comment).substring(0, 100);
  }

  // キー生成（import:タイムスタンプ で既存記憶と区別）
  const timestamp = Date.now();
  // 一括投入時のキー衝突回避（1msずらす）
  const key = `${type}:${timestamp}:${Math.random().toString(36).substring(2, 6)}`;
  const createdAt = data.created_at || new Date(timestamp).toISOString();

  // v1.2追加 - 重複チェック（Vectorize類似度検索）
  // 同じ内容の記憶が既にあればスキップ（force:trueで強制投入も可能）
  if (!data.force && env.VECTORIZE && env.GEMINI_API_KEY) {
    try {
      const checkText = `${topic} ${summary.substring(0, 200)}`;
      const similar = await searchVectors(checkText, {}, 1, env);
      if (similar.length > 0 && similar[0].score >= DUPLICATE_THRESHOLD) {
        return {
          error: `重複スキップ: 類似記憶あり（スコア${similar[0].score.toFixed(3)}、キー:${similar[0].id}）`,
          skipped: true,
        };
      }
    } catch (e) {
      // 重複チェック失敗時は投入を続行（チェックできないだけで止めない）
      console.warn('[Import] 重複チェックスキップ:', e.message);
    }
  }

  // D1に挿入
  // v1.3追加 - sourceカラム（インポート元: import固定 / JSONにsourceがあればそちらを使う）
  const source = data.source || 'import';
  await env.DB.prepare(`
    INSERT INTO memories (key, type, topic, summary, decisions, sister, category,
                          round, lead, mood, ai_summary, ai_error, created_at,
                          emotion_user, emotion_ai, emotion_comment, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    key, type, topic, summary, JSON.stringify(decisions),
    sister, category,
    1, null, data.mood || 'neutral',
    0, 'direct_import', createdAt,
    emotionUser, emotionAi, emotionComment, source
  ).run();

  // Vectorize にembedding保存（失敗しても記憶保存は壊さない）
  // v1.1変更 - summaryが長い場合はGemini Flashで短縮要約を生成してembeddingに使う
  // D1には全文を保持（経緯が大事！）、Vectorizeには検索用の短い要約でembedding
  let embeddingText = `${topic} ${summary}`;
  if (summary.length > SUMMARY_SHORT_THRESHOLD && env.GEMINI_API_KEY) {
    try {
      const shortSummary = await _generateShortSummary(topic, summary, env);
      if (shortSummary) embeddingText = `${topic} ${shortSummary}`;
    } catch (e) {
      console.warn('[Import] 短縮要約生成スキップ:', e.message);
      // 失敗時は全文でembedding（500文字でvector.js側がtruncateする）
    }
  }
  await upsertVector(key, embeddingText, {
    type, sister: sister || '', created_at: createdAt,
  }, env).catch(e => console.warn('[Import] embedding保存スキップ:', e.message));

  // 100件制限チェック
  const countRow = await env.DB.prepare('SELECT COUNT(*) as cnt FROM memories').first();
  if (countRow && countRow.cnt > MAX_MEMORIES) {
    const excess = countRow.cnt - MAX_MEMORIES;
    await env.DB.prepare(`
      DELETE FROM memories WHERE key IN (
        SELECT key FROM memories ORDER BY created_at ASC LIMIT ?
      )
    `).bind(excess).run();
  }

  return { key };
}

// ============================================================
// v1.1追加 - Gemini Flash 短縮要約（Vectorize embedding用）
// D1には全文を保持し、embeddingには短い要約を使う
// 「経緯を残しつつ検索しやすい要約」を生成
// ============================================================

async function _generateShortSummary(topic, fullText, env) {
  const apiUrl = `${GEMINI_API_BASE}/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const prompt = `以下の開発記録を、検索用の短い要約（80〜150文字）にしてください。
重要な判断理由や失敗の学びも含めてください。JSON等は不要、プレーンテキストのみ。

トピック: ${topic}
本文:
${fullText.substring(0, 2000)}`;

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 256, temperature: 0.1 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini API ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return text.trim().substring(0, 200) || null;
}
