// このファイルは何をするか:
// COCOMITalkのリアルタイム検索モジュール（Phase 2a）。
// Brave Search API経由でウェブ検索を行い、結果を整形して返す。
// 三姉妹が「知らないこと」をリアルタイムで調べられるようになる。
// v1.0 作成 2026-03-12 - Phase 2a 新規作成
'use strict';

import { jsonResponse, jsonError, fetchWithRetry } from './utils.js';

// ============================================================
// Brave Search API設定
// ============================================================

// v1.0 - Brave Web Search APIエンドポイント
const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

// 検索結果の最大件数（コスト節約＋プロンプト注入量の制限）
const MAX_RESULTS = 5;

// クエリの最大文字数（安全ガイド準拠）
const MAX_QUERY_LENGTH = 200;

// ============================================================
// 検索エンドポイントハンドラー
// ============================================================

/**
 * POST /search ハンドラー
 * リクエスト: { query: "検索キーワード", count: 3 }
 * レスポンス: { results: [...], query, totalCount }
 */
export async function handleSearch(request, env) {
  // Brave Search APIキーの存在チェック
  if (!env.BRAVE_SEARCH_KEY) {
    return jsonError('BRAVE_SEARCH_KEY が未設定です', 500);
  }

  try {
    const body = await request.json();
    const query = (body.query || '').trim();

    // バリデーション
    if (!query) {
      return jsonError('query は必須です', 400);
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return jsonError(`query は${MAX_QUERY_LENGTH}文字以内にしてください`, 400);
    }

    // 検索件数（1〜5件、デフォルト3）
    const count = Math.min(Math.max(parseInt(body.count) || 3, 1), MAX_RESULTS);

    // Brave Search API呼び出し
    const searchResults = await searchBrave(query, count, env);

    return jsonResponse(searchResults);

  } catch (e) {
    console.error('[Search] エラー:', e.message);
    return jsonError(`検索エラー: ${e.message}`, 500);
  }
}

// ============================================================
// Brave Search API呼び出し＋結果整形
// ============================================================

/**
 * Brave Search APIでウェブ検索を実行
 * @param {string} query - 検索キーワード
 * @param {number} count - 取得件数
 * @param {object} env - Worker環境変数
 * @returns {object} { results, query, totalCount }
 */
async function searchBrave(query, count, env) {
  // URLパラメータ構築
  const params = new URLSearchParams({
    q: query,
    count: String(count),
    search_lang: 'ja',        // 日本語優先
    result_filter: 'web',     // ウェブ検索結果のみ
    text_decorations: 'false', // HTMLタグなしのプレーンテキスト
  });

  const apiUrl = `${BRAVE_SEARCH_URL}?${params.toString()}`;

  const response = await fetchWithRetry(apiUrl, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': env.BRAVE_SEARCH_KEY,
    },
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Brave API ${response.status}: ${errText.substring(0, 200)}`);
  }

  const data = await response.json();

  // 検索結果を整形（三姉妹のプロンプトに注入しやすい形に）
  const results = formatResults(data);

  return {
    results,
    query,
    totalCount: results.length,
  };
}

/**
 * Brave Search APIのレスポンスを整形
 * プロンプト注入用にコンパクトな形式に変換
 * @param {object} data - Brave APIレスポンス
 * @returns {Array} 整形済み検索結果
 */
function formatResults(data) {
  const webResults = data?.web?.results || [];

  return webResults.map((r, i) => ({
    rank: i + 1,
    title: r.title || '',
    url: r.url || '',
    // descriptionを200文字に制限（プロンプト注入時のトークン節約）
    description: (r.description || '').substring(0, 200),
    // 公開日があれば含める
    date: r.page_age || r.age || null,
  }));
}
