// このファイルは何をするか:
// COCOMITalkの記憶モジュール。Cloudflare D1（SQLite）への記憶の読み書き削除を提供する。
// AI要約機能はsummarizer.jsに分離（v1.20）。
// v1.0 作成 2026-03-11（index.js v1.6から分離）
// v1.1〜v1.17 略（詳細はgit logを参照）
// v1.18 2026-03-28 - SAVE summary抽象化問題修正: 具体情報保持ルール追加、summary上限80→200文字、substring100→250
// v1.19 2026-03-28 - 文末完結処理改善: endings判定を大幅拡充、「について議論した」強制付加を廃止
// v1.20 2026-03-28 - AI要約関連をsummarizer.jsに分離（500行制限対応）。memory.jsはD1操作に専念

import { jsonResponse, jsonError } from './utils.js';
import { upsertVector, deleteVector, deleteVectors } from './vector.js';
// v1.20追加 - AI要約をsummarizer.jsからimport
import { summarizeWithAI, cleanSummaryEnding } from './summarizer.js';

// ============================================================
// 定数
// ============================================================
const MAX_MEMORIES = 1000000;

// 姉妹IDマッピング（API名→COCOMIOS三姉妹ID）
const SISTER_ID_MAP = { gpt: 'onee', claude: 'kuro', koko: 'koko' };
function _normalizeSister(raw) {
  if (!raw) return null;
  return SISTER_ID_MAP[raw] || raw;
}

// ============================================================
// メモリーエンドポイントハンドラー（GET/POST/DELETE分岐）
// ============================================================
export async function handleMemory(request, env) {
  if (!env.DB) {
    return jsonError('D1 database DB が未設定です', 500);
  }
  const method = request.method;
  if (method === 'GET') return memoryGet(request, env);
  if (method === 'POST') return memorySave(request, env);
  if (method === 'DELETE') return memoryDelete(request, env);
  return jsonError('Method not allowed for /memory', 405);
}

// ============================================================
// GET /memory — 記憶を取得
// ============================================================
async function memoryGet(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '5', 10), 100);
  const filterType = url.searchParams.get('type') || null;
  const filterSister = url.searchParams.get('sister') || null;
  const filterCategory = url.searchParams.get('category') || null;

  try {
    let sql = 'SELECT * FROM memories';
    const conditions = [];
    const params = [];
    if (filterType) { conditions.push('type = ?'); params.push(filterType); }
    if (filterSister) { conditions.push('sister = ?'); params.push(filterSister); }
    if (filterCategory) { conditions.push('category = ?'); params.push(filterCategory); }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const { results } = await env.DB.prepare(sql).bind(...params).all();
    const memories = results.map(row => _rowToMemory(row));
    memories.reverse();

    const countRow = await env.DB.prepare('SELECT COUNT(*) as cnt FROM memories').first();
    const total = countRow?.cnt || 0;

    return jsonResponse({ memories, total });
  } catch (e) {
    return jsonError(`メモリー取得エラー: ${e.message}`, 500);
  }
}

// ============================================================
// POST /memory — 記憶を1件保存
// ============================================================
export async function memorySave(request, env) {
  try {
    const body = await request.json();
    if (!body.topic) return jsonError('topic は必須です', 400);

    const type = body.type || 'meeting';
    let summary = body.summary || '';
    let decisions = body.decisions || [];
    let aiSummary = false;
    let aiError = null;
    let aiTopic = null;
    let aiCategory = null;
    let aiEmotionUser = null;
    let aiEmotionAi = null;
    let aiEmotionComment = null;

    // rawHistoryがあればAI要約で高品質な記憶を生成
    if (body.rawHistory && body.rawHistory.length > 0 && env.GEMINI_API_KEY) {
      try {
        const aiResult = await summarizeWithAI(body.topic, body.rawHistory, env, type);
        if (aiResult) {
          const validSummary = aiResult.summary && aiResult.summary.length >= 10;
          let aiDecisions = [];
          if (Array.isArray(aiResult.decisions) && aiResult.decisions.length > 0) {
            aiDecisions = aiResult.decisions
              .filter(d => typeof d === 'string' && d.length > 3)
              .map(d => d
                .replace(/^\s*#{1,6}\s+\d*\.?\s*/g, '')
                .replace(/^\s*[-*]+\s+/g, '')
                .replace(/\*{1,3}/g, '')
                .replace(/\|[^|]*\|/g, '')
                .trim()
                .substring(0, 40))
              .filter(d => d.length > 5);
          }
          const validDecisions = aiDecisions.length > 0;

          // v1.18変更 - summary上限250文字 / v1.19変更 - 文末処理改善
          let finalSummary = validSummary ? aiResult.summary.substring(0, 250) : summary;
          if (validSummary && finalSummary.length > 10) {
            finalSummary = cleanSummaryEnding(finalSummary);
          }
          summary = finalSummary;
          decisions = validDecisions ? aiDecisions : decisions;
          aiSummary = validSummary;
          if (aiResult.topic) aiTopic = aiResult.topic;
          if (aiResult.category) aiCategory = aiResult.category;
          const euRaw = Number(aiResult.emotion_user);
          if (!isNaN(euRaw) && euRaw >= 1 && euRaw <= 5) aiEmotionUser = Math.round(euRaw);
          const eaRaw = Number(aiResult.emotion_ai);
          if (!isNaN(eaRaw) && eaRaw >= 1 && eaRaw <= 5) aiEmotionAi = Math.round(eaRaw);
          if (aiResult.emotion_comment) {
            aiEmotionComment = String(aiResult.emotion_comment).substring(0, 100);
          }
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
    const topic = aiTopic || body.topic;
    const category = aiCategory || body.category || null;
    const createdAt = new Date(timestamp).toISOString();
    const source = body.source || 'cocomitalk';
    const sister = _normalizeSister(body.sister);

    await env.DB.prepare(`
      INSERT INTO memories (key, type, topic, summary, decisions, sister, category,
                            round, lead, mood, ai_summary, ai_error, created_at,
                            emotion_user, emotion_ai, emotion_comment, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      key, type, topic, summary, JSON.stringify(decisions),
      sister, category,
      body.round || 1, body.lead || null, body.mood || 'neutral',
      aiSummary ? 1 : 0, aiError, createdAt,
      aiEmotionUser, aiEmotionAi, aiEmotionComment, source
    ).run();

    // Vectorize にembeddingを保存
    const embeddingText = `${topic} ${summary}`;
    await upsertVector(key, embeddingText, {
      type, sister: sister || '', created_at: createdAt,
    }, env).catch(e => console.warn('[Memory] embedding保存スキップ:', e.message));

    // 上限超過チェック
    const countRow = await env.DB.prepare('SELECT COUNT(*) as cnt FROM memories').first();
    if (countRow && countRow.cnt > MAX_MEMORIES) {
      const excess = countRow.cnt - MAX_MEMORIES;
      await env.DB.prepare(`
        DELETE FROM memories WHERE key IN (
          SELECT key FROM memories ORDER BY created_at ASC LIMIT ?
        )
      `).bind(excess).run();
    }

    const memory = {
      key, type, topic, summary, decisions, sister, category,
      round: body.round || 1, lead: body.lead || null,
      mood: body.mood || 'neutral',
      aiSummary, aiError, createdAt,
      emotionUser: aiEmotionUser, emotionAi: aiEmotionAi, emotionComment: aiEmotionComment,
      source,
    };
    return jsonResponse({ success: true, key, memory });
  } catch (e) {
    return jsonError(`メモリー保存エラー: ${e.message}`, 500);
  }
}

// ============================================================
// DELETE /memory — 記憶を削除
// ============================================================
async function memoryDelete(request, env) {
  try {
    const body = await request.json();

    if (body.action === 'deleteAll') {
      const { results } = await env.DB.prepare('SELECT key FROM memories').all();
      const keys = results.map(r => r.key);
      const count = keys.length;
      await env.DB.prepare('DELETE FROM memories').run();
      await deleteVectors(keys, env).catch(() => {});
      return jsonResponse({ success: true, deleted: count });
    }

    if (body.action === 'deleteByPeriod') {
      if (!body.before) return jsonError('before（ISO日時）は必須です', 400);
      const { results } = await env.DB.prepare(
        'SELECT key FROM memories WHERE created_at < ?'
      ).bind(body.before).all();
      const keys = results.map(r => r.key);
      const count = keys.length;
      if (count > 0) {
        await env.DB.prepare('DELETE FROM memories WHERE created_at < ?').bind(body.before).run();
        await deleteVectors(keys, env).catch(() => {});
      }
      return jsonResponse({ success: true, deleted: count });
    }

    if (!body.key) return jsonError('key は必須です', 400);
    await env.DB.prepare('DELETE FROM memories WHERE key = ?').bind(body.key).run();
    await deleteVector(body.key, env).catch(() => {});
    return jsonResponse({ success: true, deleted: body.key });
  } catch (e) {
    return jsonError(`メモリー削除エラー: ${e.message}`, 500);
  }
}

// ============================================================
// ヘルパー関数
// ============================================================
export function _rowToMemory(row) {
  return {
    key: row.key, type: row.type, topic: row.topic, summary: row.summary,
    decisions: _parseJSON(row.decisions, []),
    sister: row.sister, category: row.category,
    round: row.round, lead: row.lead, mood: row.mood,
    aiSummary: row.ai_summary === 1, aiError: row.ai_error, createdAt: row.created_at,
    emotionUser: row.emotion_user, emotionAi: row.emotion_ai, emotionComment: row.emotion_comment,
    source: row.source || 'cocomitalk',
  };
}

function _parseJSON(str, fallback) {
  try { return JSON.parse(str); } catch (_) { return fallback; }
}
