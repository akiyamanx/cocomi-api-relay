// このファイルは何をするか:
// COCOMITalkの記憶モジュール。Cloudflare D1（SQLite）への記憶の読み書き削除と、
// Gemini FlashによるAI要約機能を提供する。
// v1.0 作成 2026-03-11（index.js v1.6から分離）
// v1.1 2026-03-11 - AI要約品質改善（summary/decisions長さチェック、few-shot例追加）
// v1.2 2026-03-11 - マークダウン記法除去+summary文末完結指示+プロンプト強化
// v1.3 2026-03-11 - 一括削除（deleteAll）対応追加
// v1.4 2026-03-11 - GET limit上限20→100引き上げ（メモリー管理UI全件表示対応）
// v1.5 2026-03-12 - chat記憶対応（type分岐+チャット用AI要約プロンプト+sister/categoryフィールド）
// v1.6 2026-03-13 - GET /memoryにtype/sister/categoryフィルタ追加（スマート取得）
// v1.7 2026-03-13 - KV→D1（SQLite）移行。API互換を維持しストレージ層のみ差し替え
// v1.8 2026-03-13 - クリーンアップ: handleMigrate削除（KV→D1移行完了済み）
// v1.9 2026-03-13 - 期間指定削除サーバーサイド化（deleteByPeriod アクション追加）
// v1.10 2026-03-15 - Step 6 Phase 2: Vectorize RAG連携（保存時embedding / 削除時ベクトル削除）
// v1.11 2026-03-15 - 感情の温度記憶（emotion_user / emotion_ai / emotion_comment追加）

import { jsonResponse, jsonError } from './utils.js';
// v1.10追加 - Vectorize連携（embedding保存・削除）
import { upsertVector, deleteVector, deleteVectors } from './vector.js';

// ============================================================
// Gemini API設定（AI要約用）
// ============================================================

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// ============================================================
// 記憶の最大件数（KV時代の100件制限を引き継ぎ）
// D1なら拡張容易だが、まずは同じ制限で安定運用
// ============================================================
const MAX_MEMORIES = 100;

// ============================================================
// メモリーD1操作（Step 6 Phase 2: KV→D1移行）
// D1データベース: cocomi-memory（wrangler.tomlでバインド）
// テーブル: memories（1テーブル構成）
// ============================================================

// メモリーエンドポイントハンドラー（GET/POST/DELETE分岐）
export async function handleMemory(request, env) {
  // v1.7変更 - D1バインディングチェック
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
// GET /memory — 記憶を取得（D1 SQLクエリ）
// クエリパラメータ: type, sister, category, limit
// 例: GET /memory?type=chat&sister=koko&limit=3
// ============================================================
async function memoryGet(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '5', 10), 100);
  const filterType = url.searchParams.get('type') || null;
  const filterSister = url.searchParams.get('sister') || null;
  const filterCategory = url.searchParams.get('category') || null;

  try {
    // v1.7変更 - SQLクエリを動的構築（KV走査→SQL一発に）
    let sql = 'SELECT * FROM memories';
    const conditions = [];
    const params = [];

    if (filterType) {
      conditions.push('type = ?');
      params.push(filterType);
    }
    if (filterSister) {
      conditions.push('sister = ?');
      params.push(filterSister);
    }
    if (filterCategory) {
      conditions.push('category = ?');
      params.push(filterCategory);
    }
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const { results } = await env.DB.prepare(sql).bind(...params).all();
    // v1.7追加 - snake_case→camelCase変換（フロント互換）
    const memories = results.map(row => _rowToMemory(row));
    // 古い順に並べ直す（プロンプト注入時に時系列が自然になる）
    memories.reverse();

    // total件数を取得
    const countRow = await env.DB.prepare('SELECT COUNT(*) as cnt FROM memories').first();
    const total = countRow?.cnt || 0;

    return jsonResponse({ memories, total });
  } catch (e) {
    return jsonError(`メモリー取得エラー: ${e.message}`, 500);
  }
}

// ============================================================
// POST /memory — 記憶を1件保存（D1 INSERT）
// rawHistoryがあればGemini FlashでAI要約を生成してから保存
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
    // v1.11追加 - 感情の温度
    let aiEmotionUser = null;
    let aiEmotionAi = null;
    let aiEmotionComment = null;

    // rawHistoryがあればAI要約で高品質な記憶を生成
    if (body.rawHistory && body.rawHistory.length > 0 && env.GEMINI_API_KEY) {
      try {
        const aiResult = await summarizeWithAI(body.topic, body.rawHistory, env, type);
        if (aiResult) {
          const validSummary = aiResult.summary && aiResult.summary.length >= 10;
          // マークダウン記法を除去+40文字以内にトリム
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

          // summaryの文末を完結させる
          let finalSummary = validSummary ? aiResult.summary.substring(0, 100) : summary;
          if (validSummary && finalSummary.length > 10) {
            const endings = /[。た！だよね]$/;
            if (!endings.test(finalSummary)) {
              finalSummary = finalSummary.replace(/[をがはのにやと、]+$/, '');
              if (!endings.test(finalSummary)) {
                finalSummary = finalSummary + 'について議論した';
              }
            }
          }
          summary = finalSummary;
          decisions = validDecisions ? aiDecisions : decisions;
          aiSummary = validSummary;
          if (aiResult.topic) aiTopic = aiResult.topic;
          if (aiResult.category) aiCategory = aiResult.category;
          // v1.11追加 - 感情の温度（1〜5にクランプ、範囲外はnull）
          if (typeof aiResult.emotion_user === 'number') {
            aiEmotionUser = Math.max(1, Math.min(5, Math.round(aiResult.emotion_user)));
          }
          if (typeof aiResult.emotion_ai === 'number') {
            aiEmotionAi = Math.max(1, Math.min(5, Math.round(aiResult.emotion_ai)));
          }
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

    // v1.7変更 - D1にINSERT（KV put→SQL INSERT）
    // v1.11変更 - 感情の温度3カラム追加
    await env.DB.prepare(`
      INSERT INTO memories (key, type, topic, summary, decisions, sister, category,
                            round, lead, mood, ai_summary, ai_error, created_at,
                            emotion_user, emotion_ai, emotion_comment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      key, type, topic, summary, JSON.stringify(decisions),
      body.sister || null, category,
      body.round || 1, body.lead || null, body.mood || 'neutral',
      aiSummary ? 1 : 0, aiError, createdAt,
      aiEmotionUser, aiEmotionAi, aiEmotionComment
    ).run();

    // v1.10追加 - Vectorize にembeddingを保存（失敗しても記憶保存は壊さない）
    const embeddingText = `${topic} ${summary}`;
    await upsertVector(key, embeddingText, {
      type, sister: body.sister || '', created_at: createdAt,
    }, env).catch(e => console.warn('[Memory] embedding保存スキップ:', e.message));

    // v1.7変更 - 100件制限（KV index管理→SQL COUNT+DELETE）
    const countRow = await env.DB.prepare('SELECT COUNT(*) as cnt FROM memories').first();
    if (countRow && countRow.cnt > MAX_MEMORIES) {
      const excess = countRow.cnt - MAX_MEMORIES;
      await env.DB.prepare(`
        DELETE FROM memories WHERE key IN (
          SELECT key FROM memories ORDER BY created_at ASC LIMIT ?
        )
      `).bind(excess).run();
    }

    // レスポンスはcamelCase形式で返す（フロント互換）
    const memory = {
      key, type, topic, summary, decisions,
      sister: body.sister || null, category,
      round: body.round || 1, lead: body.lead || null,
      mood: body.mood || 'neutral',
      aiSummary, aiError, createdAt,
      // v1.11追加 - 感情の温度
      emotionUser: aiEmotionUser,
      emotionAi: aiEmotionAi,
      emotionComment: aiEmotionComment,
    };
    return jsonResponse({ success: true, key, memory });
  } catch (e) {
    return jsonError(`メモリー保存エラー: ${e.message}`, 500);
  }
}

// ============================================================
// Gemini Flash AI要約（v1.1〜v1.5 — 変更なし）
// ============================================================

async function summarizeWithAI(topic, rawHistory, env, type = 'meeting') {
  const historyText = rawHistory
    .map(h => `${h.sister || h.role || '参加者'}: ${h.content}`)
    .join('\n')
    .substring(0, 2000);

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

  return extractJSON(text);
}

// チャット要約用プロンプト
// v1.11変更 - 感情の温度フィールド追加
function _buildChatPrompt(historyText) {
  return `以下の1対1チャット会話を要約してJSON形式で出力してください。
JSON以外は絶対に出力しないでください。前置き文もコードフェンスも不要です。

出力形式の例:
{"summary":"午前中のメンテナンス作業が大変だったという話をした。疲れたけど頑張った","decisions":[],"category":"雑談","topic":"仕事の疲れについて","emotion_user":3,"emotion_ai":4,"emotion_comment":"仕事の疲れを吐き出しつつも前向きな雰囲気"}

ルール:
- summaryは30〜80文字の日本語。「〜した」「〜について話した」等で文を完結させること
- topicは会話の主題を10〜30文字で要約
- categoryは以下から1つ選択: 開発/雑談/ドライブ/食事/晩酌/仕事/趣味/相談/家族
- decisionsは決まったことがあれば配列で。雑談なら空配列[]
- emotion_userはユーザーの感情温度を1〜5の整数で（1=落ち込み 2=元気ない 3=普通 4=楽しい 5=最高）
- emotion_aiはAI側の感情温度を1〜5の整数で（1=心配 2=控えめ 3=穏やか 4=楽しい 5=大喜び）
- emotion_commentは会話全体の雰囲気を30〜60文字で一言コメント
- マークダウン記法は使わない。プレーンテキストのみ
- JSON以外の文字を出力しない

チャット会話:
${historyText}`;
}

// 会議要約用プロンプト
// v1.11変更 - 感情の温度フィールド追加
function _buildMeetingPrompt(topic, historyText) {
  return `会議記録を要約してJSON形式で出力してください。
JSON以外は絶対に出力しないでください。前置き文もコードフェンスも不要です。

出力形式の例:
{"summary":"COCOMITalkの音声機能について議論し、VOICEVOXとOpenAI TTSの2系統で実装する方針に決定した","decisions":["VOICEVOXをメインTTSとして採用","OpenAI TTSをフォールバックに設定"],"emotion_user":4,"emotion_ai":5,"emotion_comment":"活発に議論が進み、全員が前向きな雰囲気だった"}

ルール:
- summaryは30〜80文字の日本語。「〜した」「〜となった」等で文を完結させること
- decisionsは具体的な決定事項のみ。各30文字以内の配列。決定事項がなければ空配列[]
- emotion_userはユーザーの感情温度を1〜5の整数で（1=落ち込み 2=元気ない 3=普通 4=楽しい 5=最高）
- emotion_aiはAI側の感情温度を1〜5の整数で（1=心配 2=控えめ 3=穏やか 4=楽しい 5=大喜び）
- emotion_commentは会議全体の雰囲気を30〜60文字で一言コメント
- マークダウン記法(#,**,|,-等)は使わない。プレーンテキストのみ
- 見出しや箇条書き記号を含めない
- JSON以外の文字を出力しない

議題: ${topic}
会議記録:
${historyText}`;
}

// 堅牢なJSON抽出（6段階フォールバック）
function extractJSON(text) {
  try { return JSON.parse(text.trim()); } catch (_) {}
  const clean = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(clean); } catch (_) {}
  const fi = clean.indexOf('{');
  const li = clean.lastIndexOf('}');
  if (fi !== -1 && li > fi) {
    try { return JSON.parse(clean.substring(fi, li + 1)); } catch (_) {}
  }
  if (fi !== -1) {
    const p = clean.substring(fi);
    try { return JSON.parse(p + '"}]}'); } catch (_) {}
    try { return JSON.parse(p + '"]}'); } catch (_) {}
    try { return JSON.parse(p + '"}'); } catch (_) {}
  }
  throw new Error('JSON抽出失敗: ' + text.substring(0, 150));
}

// ============================================================
// DELETE /memory — 記憶を削除（D1 DELETE）
// body.action === 'deleteAll' で全件削除
// body.action === 'deleteByPeriod' + body.before で期間指定削除
// body.key で1件削除
// ============================================================
async function memoryDelete(request, env) {
  try {
    const body = await request.json();

    // 一括削除
    if (body.action === 'deleteAll') {
      // v1.7変更 - SQL一発で全件削除（KVループ→DELETE FROM）
      // v1.10追加 - Vectorizeからも削除（キー一覧を先に取得）
      const { results } = await env.DB.prepare('SELECT key FROM memories').all();
      const keys = results.map(r => r.key);
      const count = keys.length;
      await env.DB.prepare('DELETE FROM memories').run();
      await deleteVectors(keys, env).catch(() => {});
      return jsonResponse({ success: true, deleted: count });
    }

    // v1.8追加 - 期間指定削除（before以前の記憶をSQL一発で削除）
    if (body.action === 'deleteByPeriod') {
      if (!body.before) return jsonError('before（ISO日時）は必須です', 400);
      // v1.10追加 - 削除対象のキーを先に取得（Vectorize削除用）
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

    // 1件削除
    if (!body.key) return jsonError('key は必須です', 400);
    // v1.7変更 - SQL一発で削除（KV delete + index filter → DELETE WHERE）
    await env.DB.prepare('DELETE FROM memories WHERE key = ?').bind(body.key).run();
    // v1.10追加 - Vectorizeからも削除
    await deleteVector(body.key, env).catch(() => {});
    return jsonResponse({ success: true, deleted: body.key });
  } catch (e) {
    return jsonError(`メモリー削除エラー: ${e.message}`, 500);
  }
}

// ============================================================
// v1.7追加 - ヘルパー関数
// ============================================================

// D1行データ（snake_case）→フロント互換オブジェクト（camelCase）に変換
// v1.10変更 - vector.jsからも参照するためexport
export function _rowToMemory(row) {
  return {
    key: row.key,
    type: row.type,
    topic: row.topic,
    summary: row.summary,
    decisions: _parseJSON(row.decisions, []),
    sister: row.sister,
    category: row.category,
    round: row.round,
    lead: row.lead,
    mood: row.mood,
    aiSummary: row.ai_summary === 1,
    aiError: row.ai_error,
    createdAt: row.created_at,
    // v1.11追加 - 感情の温度
    emotionUser: row.emotion_user,
    emotionAi: row.emotion_ai,
    emotionComment: row.emotion_comment,
  };
}

// JSON文字列の安全なパース
function _parseJSON(str, fallback) {
  try { return JSON.parse(str); } catch (_) { return fallback; }
}
