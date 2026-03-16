// このファイルは何をするか:
// COCOMITalkの記憶直接投入モジュール。クロちゃんとの開発セッションで得た知識・決定事項を
// 三姉妹APIを経由せずにD1＋Vectorizeに直接投入する。
// Termux curlや設定画面UIから呼び出される。
// v1.0 2026-03-16 - 新規作成（実行計画書v24.0「次のステップ#1」）

import { jsonResponse, jsonError } from './utils.js';
import { upsertVector } from './vector.js';

// ============================================================
// 定数
// ============================================================

// 1回の一括投入で許可する最大件数（コスト安全策: embedding生成がAPI課金）
const MAX_BATCH_SIZE = 20;
// MAX_MEMORIESはmemory.jsと同じ値（D1全体の上限）
const MAX_MEMORIES = 100;

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

  const results = { imported: 0, errors: 0, keys: [], errorDetails: [] };

  for (const item of memories) {
    const result = await _insertOne(item, env);
    if (result.error) {
      results.errors++;
      results.errorDetails.push(result.error);
    } else {
      results.imported++;
      results.keys.push(result.key);
    }
  }

  return jsonResponse({
    success: results.imported > 0,
    imported: results.imported,
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
  const sister = data.sister || null;
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

  // D1に挿入
  await env.DB.prepare(`
    INSERT INTO memories (key, type, topic, summary, decisions, sister, category,
                          round, lead, mood, ai_summary, ai_error, created_at,
                          emotion_user, emotion_ai, emotion_comment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    key, type, topic, summary, JSON.stringify(decisions),
    sister, category,
    1, null, data.mood || 'neutral',
    0, 'direct_import', createdAt,
    emotionUser, emotionAi, emotionComment
  ).run();

  // Vectorize にembedding保存（失敗しても記憶保存は壊さない）
  const embeddingText = `${topic} ${summary}`;
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
