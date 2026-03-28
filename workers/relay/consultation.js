// COCOMITalk - 相談トピック連携ハンドラー
// このファイルは何をするか:
// claude.aiクロちゃんが書き込んだ相談トピックを、COCOMITalk会議室で取得・回答するエンドポイント
// v1.0 2026-03-28 - 新規作成（GET /consultation + POST /consultation/resolve）
'use strict';

import { jsonResponse, jsonError } from './utils.js';

/**
 * GET /consultation — 未回答の相談トピックを取得
 * COCOMITalkの会議画面が画面ロード時に呼び出す
 * @param {URL} url - リクエストURL（クエリパラメータ: status, limit）
 * @param {object} env - Cloudflare環境変数
 * @returns {Response}
 */
export async function handleGetConsultation(url, env) {
  try {
    const status = url.searchParams.get('status') || 'pending';
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 5, 1), 10);

    // v1.0 - statusのバリデーション（不正な値を弾く）
    const allowedStatuses = ['pending', 'in_progress', 'resolved', 'all'];
    if (!allowedStatuses.includes(status)) {
      return jsonError(`無効なstatus: ${status}`, 400);
    }

    let sql;
    let params;
    if (status === 'all') {
      sql = `
        SELECT id, topic, question, context, akiya_comment, status, resolution, source, created_at, resolved_at
        FROM consultation_topics
        ORDER BY created_at DESC
        LIMIT ?
      `;
      params = [limit];
    } else {
      sql = `
        SELECT id, topic, question, context, akiya_comment, status, resolution, source, created_at, resolved_at
        FROM consultation_topics
        WHERE status = ?
        ORDER BY created_at DESC
        LIMIT ?
      `;
      params = [status, limit];
    }

    const stmt = env.DB.prepare(sql).bind(...params);
    const { results } = await stmt.all();

    return jsonResponse({
      consultations: results || [],
      count: (results || []).length,
      status,
      limit,
    });
  } catch (e) {
    console.error('[consultation] GET エラー:', e.message);
    return jsonError(`consultation GET エラー: ${e.message}`, 500);
  }
}

/**
 * POST /consultation — 新しい相談トピックを書き込む
 * claude.aiクロちゃんがMCP経由、またはCOCOMITalkから直接書き込む
 * @param {Request} request - リクエスト（body: { topic, question, context?, source? }）
 * @param {object} env - Cloudflare環境変数
 * @returns {Response}
 */
export async function handlePostConsultation(request, env) {
  try {
    const body = await request.json();
    const { topic, question, context, source } = body;

    // v1.0 - 必須フィールドのバリデーション
    if (!topic || !topic.trim()) {
      return jsonError('topic は必須です', 400);
    }
    if (!question || !question.trim()) {
      return jsonError('question は必須です', 400);
    }

    const sql = `
      INSERT INTO consultation_topics (topic, question, context, source)
      VALUES (?, ?, ?, ?)
    `;
    const stmt = env.DB.prepare(sql).bind(
      topic.trim(),
      question.trim(),
      context ? context.trim() : null,
      source || 'web-claude'
    );
    const result = await stmt.run();

    return jsonResponse({
      success: true,
      id: result.meta.last_row_id,
      topic: topic.trim(),
      status: 'pending',
    }, 201);
  } catch (e) {
    console.error('[consultation] POST エラー:', e.message);
    return jsonError(`consultation POST エラー: ${e.message}`, 500);
  }
}

/**
 * POST /consultation/resolve — 相談トピックに回答を書き戻す
 * 三姉妹会議の結果をDBに保存する（アキヤが「DL＋DB保存」を選んだ時のみ呼ばれる）
 * @param {Request} request - リクエスト（body: { id, resolution, akiya_comment? }）
 * @param {object} env - Cloudflare環境変数
 * @returns {Response}
 */
export async function handleResolveConsultation(request, env) {
  try {
    const body = await request.json();
    const { id, resolution, akiya_comment } = body;

    // v1.0 - 必須フィールドのバリデーション
    if (!id) {
      return jsonError('id は必須です', 400);
    }
    if (!resolution || !resolution.trim()) {
      return jsonError('resolution は必須です', 400);
    }

    // 対象の相談トピックが存在するか確認
    const check = env.DB.prepare('SELECT id, status FROM consultation_topics WHERE id = ?').bind(id);
    const existing = await check.first();
    if (!existing) {
      return jsonError(`相談トピック id=${id} が見つかりません`, 404);
    }

    const sql = `
      UPDATE consultation_topics
      SET resolution = ?,
          akiya_comment = COALESCE(?, akiya_comment),
          status = 'resolved',
          resolved_at = datetime('now')
      WHERE id = ?
    `;
    const stmt = env.DB.prepare(sql).bind(
      resolution.trim(),
      akiya_comment ? akiya_comment.trim() : null,
      id
    );
    await stmt.run();

    return jsonResponse({
      success: true,
      id,
      status: 'resolved',
    });
  } catch (e) {
    console.error('[consultation] resolve エラー:', e.message);
    return jsonError(`consultation resolve エラー: ${e.message}`, 500);
  }
}
