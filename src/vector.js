// このファイルは何をするか:
// COCOMITalkのベクトル検索モジュール。記憶のembedding生成とVectorize操作を管理する。
// Gemini text-embedding-004でembeddingを生成し、Cloudflare Vectorizeに保存・検索する。
// v1.0 2026-03-15 - 新規作成（Step 6 Phase 2: Vectorize RAG）

import { jsonResponse, jsonError } from './utils.js';

// ============================================================
// 定数
// ============================================================

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const EMBEDDING_MODEL = 'text-embedding-004';
// v1.0 embedding対象テキストの最大文字数（500文字で十分な意味を持つ）
const MAX_TEXT_LENGTH = 500;

// ============================================================
// Embedding生成（Gemini text-embedding-004）
// ============================================================

/**
 * テキストからembedding（768次元ベクトル）を生成
 * @param {string} text - embedding対象テキスト
 * @param {object} env - Worker環境変数（GEMINI_API_KEY必須）
 * @returns {Promise<number[]|null>} - 768次元のベクトル配列、失敗時null
 */
async function generateEmbedding(text, env) {
  const apiUrl = `${GEMINI_API_BASE}/models/${EMBEDDING_MODEL}:embedContent?key=${env.GEMINI_API_KEY}`;
  const truncated = text.substring(0, MAX_TEXT_LENGTH);

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text: truncated }] },
    }),
  });

  if (!res.ok) throw new Error(`Embedding API ${res.status}`);
  const data = await res.json();
  return data?.embedding?.values || null;
}

// ============================================================
// Vectorize操作
// ============================================================

/**
 * 記憶をVectorizeに保存（D1保存と同時に呼ばれる）
 * @param {string} key - D1のキー（例: "chat:1710000000000"）
 * @param {string} text - embedding対象テキスト（topic + summary）
 * @param {object} metadata - フィルタ用メタデータ {type, sister, created_at}
 * @param {object} env - Worker環境変数
 * @returns {Promise<boolean|null>} - 成功時true、失敗時null
 */
async function upsertVector(key, text, metadata, env) {
  if (!env.VECTORIZE || !env.GEMINI_API_KEY) return null;

  try {
    const values = await generateEmbedding(text, env);
    if (!values) return null;

    await env.VECTORIZE.upsert([{
      id: key,
      values,
      metadata: {
        type: metadata.type || 'chat',
        sister: metadata.sister || '',
        created_at: metadata.created_at || new Date().toISOString(),
      },
    }]);

    console.log(`[Vector] upsert成功: ${key}`);
    return true;
  } catch (e) {
    console.error(`[Vector] upsert失敗: ${e.message}`);
    return null;
  }
}

/**
 * テキストで意味検索（類似記憶を取得）
 * @param {string} queryText - 検索クエリ（ユーザーの発言）
 * @param {object} filter - メタデータフィルタ（type, sister等）
 * @param {number} topK - 取得件数（デフォルト3）
 * @param {object} env - Worker環境変数
 * @returns {Promise<Array>} - [{id, score, metadata}, ...] ヒットしたキーとスコア
 */
async function searchVectors(queryText, filter, topK, env) {
  if (!env.VECTORIZE || !env.GEMINI_API_KEY) return [];

  try {
    const values = await generateEmbedding(queryText, env);
    if (!values) return [];

    const options = { topK: topK || 3, returnMetadata: 'all' };

    // メタデータフィルタ（Vectorize v2のフィルタ構文）
    if (filter && Object.keys(filter).length > 0) {
      options.filter = filter;
    }

    const results = await env.VECTORIZE.query(values, options);
    return (results.matches || []).map(m => ({
      id: m.id,
      score: m.score,
      metadata: m.metadata,
    }));
  } catch (e) {
    console.error(`[Vector] 検索失敗: ${e.message}`);
    return [];
  }
}

/**
 * ベクトルを1件削除（D1の記憶削除時に呼ばれる）
 * @param {string} key - D1のキー
 * @param {object} env - Worker環境変数
 */
async function deleteVector(key, env) {
  if (!env.VECTORIZE) return;
  try {
    await env.VECTORIZE.deleteByIds([key]);
    console.log(`[Vector] 削除成功: ${key}`);
  } catch (e) {
    console.error(`[Vector] 削除失敗: ${e.message}`);
  }
}

/**
 * ベクトルを複数削除（期間指定削除・全件削除時に呼ばれる）
 * @param {string[]} keys - D1のキー配列
 * @param {object} env - Worker環境変数
 */
async function deleteVectors(keys, env) {
  if (!env.VECTORIZE || keys.length === 0) return;
  try {
    await env.VECTORIZE.deleteByIds(keys);
    console.log(`[Vector] 一括削除成功: ${keys.length}件`);
  } catch (e) {
    console.error(`[Vector] 一括削除失敗: ${e.message}`);
  }
}

// ============================================================
// /memory-search エンドポイントハンドラー
// POST { query, type?, sister?, limit? }
// ============================================================

/**
 * 意味検索エンドポイント
 * ユーザーの発言テキストからVectorize検索→D1で記憶本体を取得
 * @param {Request} request
 * @param {object} env
 * @param {Function} rowToMemory - D1行→フロント互換オブジェクト変換関数
 * @returns {Promise<Response>}
 */
export async function handleMemorySearch(request, env, rowToMemory) {
  try {
    const body = await request.json();
    if (!body.query) return jsonError('query は必須です', 400);

    const topK = Math.min(parseInt(body.limit || '3', 10), 10);

    // Vectorize フィルタ構築
    const filter = {};
    if (body.type) filter.type = body.type;
    if (body.sister) filter.sister = body.sister;

    // 意味検索
    const vectorResults = await searchVectors(body.query, filter, topK, env);
    if (vectorResults.length === 0) {
      return jsonResponse({ memories: [], total: 0 });
    }

    // ヒットしたキーでD1から記憶本体を取得
    const keys = vectorResults.map(r => r.id);
    const placeholders = keys.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT * FROM memories WHERE key IN (${placeholders}) ORDER BY created_at DESC`
    ).bind(...keys).all();

    // score情報を付与してフロント互換形式で返す
    const scoreMap = Object.fromEntries(vectorResults.map(r => [r.id, r.score]));
    const memories = results.map(row => ({
      ...rowToMemory(row),
      relevanceScore: scoreMap[row.key] || 0,
    }));

    // スコア順にソート（最も関連性が高い順）
    memories.sort((a, b) => b.relevanceScore - a.relevanceScore);

    return jsonResponse({ memories, total: memories.length });
  } catch (e) {
    return jsonError(`記憶検索エラー: ${e.message}`, 500);
  }
}

// ============================================================
// マイグレーション: 既存記憶のembedding一括生成（一時エンドポイント用）
// ============================================================

/**
 * 既存D1記憶のembeddingを一括生成してVectorizeに保存
 * POST /memory-vectorize で呼ばれる（完了後にこのエンドポイントは削除する）
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
export async function handleVectorizeMigration(request, env) {
  if (!env.VECTORIZE || !env.GEMINI_API_KEY) {
    return jsonError('VECTORIZE or GEMINI_API_KEY が未設定', 500);
  }

  try {
    const { results } = await env.DB.prepare(
      'SELECT key, type, topic, summary, sister, created_at FROM memories ORDER BY created_at ASC'
    ).all();

    let migrated = 0;
    let errors = 0;

    for (const row of results) {
      try {
        const embeddingText = `${row.topic} ${row.summary}`;
        const ok = await upsertVector(row.key, embeddingText, {
          type: row.type,
          sister: row.sister || '',
          created_at: row.created_at,
        }, env);
        if (ok) migrated++;
        else errors++;
      } catch (e) {
        console.error(`[VectorizeMigration] ${row.key}: ${e.message}`);
        errors++;
      }
    }

    return jsonResponse({
      success: true,
      total: results.length,
      migrated,
      errors,
    });
  } catch (e) {
    return jsonError(`マイグレーションエラー: ${e.message}`, 500);
  }
}

export { generateEmbedding, upsertVector, searchVectors, deleteVector, deleteVectors };
