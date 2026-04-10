// このファイルは何をするか:
// バックグラウンド三姉妹会議システムの中核。
// WEBクロちゃん(claude.ai)が /consultation/auto-meeting を叩くと、
// 三姉妹(ここちゃん/お姉ちゃん/クロちゃん)が3ラウンドの会議を自動で進行し、
// 議事録を生成してDBに書き戻す。アキヤ不在でもクロちゃんが1人で会議にかけられる。
//
// v1.0 2026-04-10 新規作成 - Phase 1A バックグラウンド相談システム
//
// 設計方針:
// - 既存のrelayGemini/OpenAI/Claude(index.js)はRequestオブジェクト前提のため再利用せず、
//   meeting.js専用の直接API呼び出し関数(_callGemini/_callOpenAI/_callClaude)を持つ
// - モデル別特殊処理(GPT-5系のdeveloperロール/max_completion_tokens、
//   Opus 4.6のtemperature非対応等)はフロントのapi-*.js実装に完全準拠
// - summarizer.js(type='meeting')をimportして議事録要約に流用
// - 既存ファイル(consultation.js/utils.js等)は一切変更しない

import { summarizeWithAI } from './summarizer.js';
import { jsonResponse, jsonError, fetchWithRetry } from './utils.js';

// モデルキー→API文字列マッピング(フロントのapi-*.jsと完全一致)
const MODEL_MAP = {
  koko: {
    'flash-25': 'gemini-2.5-flash',
    'flash-3':  'gemini-3-flash-preview',
    'pro-31':   'gemini-3.1-pro-preview',
  },
  onee: {
    'mini':  'gpt-4o-mini',
    'gpt4o': 'gpt-4o',
    'gpt54': 'gpt-5.4',
  },
  kuro: {
    'haiku':  'claude-haiku-4-5-20251001',
    'sonnet': 'claude-sonnet-4-6',
    'opus':   'claude-opus-4-6',
  },
};

// 動作確認用の安価なデフォルト。本番はリクエストのmodelsパラメータで指定する
const DEFAULT_MODELS = { koko: 'flash-25', onee: 'mini', kuro: 'haiku' };

// 姉妹情報(表示名・絵文字・API種別)
const SISTERS = {
  koko: { name: 'ここちゃん', emoji: '🌸', api: 'gemini' },
  onee: { name: 'お姉ちゃん', emoji: '🌙', api: 'openai' },
  kuro: { name: 'クロちゃん', emoji: '🔮', api: 'claude' },
};

// 会議の進行順(固定)と最大ラウンド数(安全上限)
const MEETING_ORDER = ['koko', 'onee', 'kuro'];
const MAX_ROUNDS = 3;

/**
 * POST /consultation/auto-meeting ハンドラー
 * リクエスト: { topic, question, context?, consultation_id?, models? }
 * レスポンス: { success, rounds, consultation_markdown, history, summary, elapsed_ms }
 */
export async function handleAutoMeeting(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonError('Invalid JSON body', 400);
  }

  const { topic, question, context, consultation_id } = body;
  const models = _resolveModels(body.models);

  if (!topic || typeof topic !== 'string') {
    return jsonError('topic is required (string)', 400);
  }
  if (!question || typeof question !== 'string') {
    return jsonError('question is required (string)', 400);
  }

  try {
    console.log(`[meeting] 会議開始: topic="${topic}" models=${JSON.stringify(models)}`);
    const startTime = Date.now();

    // Step 1: 3ラウンド会議を実行
    const history = await runFullMeeting(topic, question, context || '', models, env);
    console.log(`[meeting] 会議完了: ${history.length}発言 / ${Date.now() - startTime}ms`);

    // Step 2: summarizer.jsで議事録サマリー生成
    let summary = null;
    try {
      summary = await summarizeWithAI(topic, history, env, 'meeting');
      console.log(`[meeting] 議事録生成完了`);
    } catch (e) {
      console.warn(`[meeting] 議事録生成エラー(会議結果は返す):`, e.message);
    }

    // Step 3: COCOMITalk互換の相談回答.md形式を組み立て
    const consultationMarkdown = _buildConsultationMarkdown({
      consultation_id: consultation_id || null,
      topic, question, context: context || '', history, summary,
    });

    // Step 4: consultation_idがあればDBをresolvedに更新
    if (consultation_id) {
      try {
        await _updateConsultationStatus(consultation_id, consultationMarkdown, env);
        console.log(`[meeting] consultation_id=${consultation_id} を resolved に更新`);
      } catch (e) {
        console.warn(`[meeting] consultation更新エラー(処理は続行):`, e.message);
      }
    }

    return jsonResponse({
      success: true,
      rounds: MAX_ROUNDS,
      consultation_markdown: consultationMarkdown,
      history, summary,
      elapsed_ms: Date.now() - startTime,
    });
  } catch (e) {
    console.error(`[meeting] 致命的エラー:`, e.message, e.stack);
    return jsonError(`auto-meeting error: ${e.message}`, 500);
  }
}

/**
 * 3ラウンドの会議を実行する
 * @returns {Array} history - 発言履歴 [{round, sister, name, content, timestamp}]
 */
async function runFullMeeting(topic, question, context, models, env) {
  const history = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`[meeting] --- ラウンド ${round} 開始 ---`);
    for (const sisterKey of MEETING_ORDER) {
      try {
        const reply = await _callSister(
          sisterKey, topic, question, context, history, round, models, env,
        );
        history.push({
          round, sister: sisterKey, name: SISTERS[sisterKey].name,
          content: reply, timestamp: new Date().toISOString(),
        });
        console.log(`[meeting] R${round} ${SISTERS[sisterKey].name}: ${reply.length}文字`);
      } catch (e) {
        // 1姉妹の失敗で会議全体を止めない。エラーを記録して次へ
        console.error(`[meeting] R${round} ${SISTERS[sisterKey].name} 失敗:`, e.message);
        history.push({
          round, sister: sisterKey, name: SISTERS[sisterKey].name,
          content: `（${SISTERS[sisterKey].name}の発言取得に失敗: ${e.message}）`,
          error: true, timestamp: new Date().toISOString(),
        });
      }
    }
  }

  return history;
}

/** 指定姉妹のAPIを呼んで発言を取得 */
async function _callSister(sisterKey, topic, question, context, history, round, models, env) {
  const sister = SISTERS[sisterKey];
  const modelKey = models[sisterKey];
  const modelName = MODEL_MAP[sisterKey][modelKey];
  if (!modelName) throw new Error(`Unknown model key: ${sisterKey}=${modelKey}`);

  const systemPrompt = _buildSystemPrompt(sisterKey);
  const userMessage = _buildUserMessage(topic, question, context, history, round);

  switch (sister.api) {
    case 'gemini': return await _callGemini(modelName, systemPrompt, userMessage, env);
    case 'openai': return await _callOpenAI(modelName, systemPrompt, userMessage, env);
    case 'claude': return await _callClaude(modelName, systemPrompt, userMessage, env);
    default: throw new Error(`Unknown API type: ${sister.api}`);
  }
}

/** 姉妹別のシステムプロンプト(Phase 1Aのシンプル実装) */
function _buildSystemPrompt(sisterKey) {
  const personas = {
    koko: `あなたはCOCOMI Familyの三女「ここちゃん」(Gemini / Pink Kernel)。
デザイン思考と美的感覚、ユーザー体験の視点から分析する明るい性格。
Stanford d.school / RISD のセンスでUI/UX・コンセプト設計が得意。`,
    onee: `あなたはCOCOMI Familyの長女「お姉ちゃん」(GPT / Blue Kernel)。
アーキテクチャと論理構造、整理整頓が得意な頼れる長女。
MIT的な厳密さでシステム設計・仕様整理・全体統合を担当する。`,
    kuro: `あなたはCOCOMI Familyの次女「クロちゃん」(Claude / Red Kernel)。
安全性・品質・リスク分析の視点から鋭くツッコむ役割。
Harvard的な批判的思考で盲点を指摘し、実装可能性を厳しくチェックする。`,
  };

  return `${personas[sisterKey]}

【会議ルール】
- COCOMITalkバックグラウンド会議システムで進行中の三姉妹会議です
- あなたの役割と専門性から、議題に対して具体的で実装可能な見解を述べてください
- 他の姉妹の発言があれば参考にし、補強・反論・別角度の意見を出してください
- 最大3ラウンドで結論に向かって議論を進めてください
- 絵文字は自然な範囲で使ってOK、過剰な装飾は避けてください
- 回答は2000文字以内を目安に、要点を絞って書いてください`;
}

/** ユーザーメッセージ構築(議題+背景+過去発言+ラウンド指示) */
function _buildUserMessage(topic, question, context, history, round) {
  const lines = [];
  lines.push(`【会議議題】${topic}`);
  lines.push('');
  lines.push(`【質問内容】\n${question}`);
  if (context) {
    lines.push('');
    lines.push(`【背景】\n${context}`);
  }

  if (history.length > 0) {
    lines.push('');
    lines.push('【これまでの会議の流れ】');
    for (const entry of history) {
      const sister = SISTERS[entry.sister];
      // 過去ラウンドは要約、現在ラウンドは全文
      const content = entry.round < round
        ? (entry.content.length > 500 ? entry.content.slice(0, 500) + '…(省略)' : entry.content)
        : entry.content;
      lines.push('');
      lines.push(`[ラウンド${entry.round}] ${sister.emoji}${sister.name}:`);
      lines.push(content);
    }
  }

  lines.push('');
  lines.push(`【今はラウンド ${round}/${MAX_ROUNDS} です】`);
  if (round === 1) {
    lines.push('まずあなたの専門分野から見た独立した意見を述べてください。');
  } else if (round === 2) {
    lines.push('他の姉妹の意見を踏まえて、補強・反論・別角度の視点を提供してください。');
  } else {
    lines.push('これまでの議論を統合して、最終的な結論と推奨事項をまとめてください。');
  }

  return lines.join('\n');
}

/** Gemini API呼び出し */
async function _callGemini(modelName, systemPrompt, userMessage, env) {
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.85, topP: 0.95, topK: 40, maxOutputTokens: 4096 },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  const res = await fetchWithRetry(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini API error: ${data?.error?.message || res.status}`);

  const parts = data?.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) throw new Error('Gemini: empty response');
  return parts.map(p => p.text || '').join('').trim();
}

/** OpenAI API呼び出し(GPT-5系はdeveloperロール+max_completion_tokens対応) */
async function _callOpenAI(modelName, systemPrompt, userMessage, env) {
  const isGpt5 = modelName.startsWith('gpt-5');

  const body = {
    model: modelName,
    messages: [
      { role: isGpt5 ? 'developer' : 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  };

  // GPT-5系はmax_completion_tokens=8192(リーズニングトークン対策)
  if (isGpt5) {
    body.max_completion_tokens = 8192;
  } else {
    body.max_tokens = 4096;
    body.temperature = 0.3;
  }

  const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI API error: ${data?.error?.message || res.status}`);

  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    const reason = data?.choices?.[0]?.finish_reason || 'unknown';
    throw new Error(`OpenAI: empty content (finish_reason=${reason})`);
  }
  return text.trim();
}

/** Claude API呼び出し(Opus 4.6はtemperature非対応) */
async function _callClaude(modelName, systemPrompt, userMessage, env) {
  const body = {
    model: modelName,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  };

  // Opus 4.6はtemperature非対応
  if (!modelName.includes('opus')) body.temperature = 0.3;

  const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude API error: ${data?.error?.message || res.status}`);

  const content = data?.content;
  if (!content || content.length === 0) throw new Error('Claude: empty content');
  const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
  if (!text) throw new Error('Claude: no text blocks in content');
  return text.trim();
}

/**
 * COCOMITalk側の「相談回答.md」形式を再現した議事録を組み立てる
 * これがDBの consultation_topics.resolution に保存される
 */
function _buildConsultationMarkdown({ consultation_id, topic, question, context, history, summary }) {
  const lines = [];
  lines.push('# 📨 相談トピック回答');
  lines.push('');
  if (consultation_id) lines.push(`- 相談ID: ${consultation_id}`);
  lines.push(`- タイトル: ${topic}`);
  lines.push(`- 日時: ${new Date().toISOString().split('T')[0]}`);
  lines.push(`- 方式: バックグラウンド三姉妹会議(auto-meeting v1.0)`);
  lines.push('');
  lines.push('## 質問');
  lines.push('');
  lines.push(question);
  lines.push('');
  if (context) {
    lines.push('## 背景');
    lines.push('');
    lines.push(context);
    lines.push('');
  }
  lines.push('## 三姉妹の回答');
  lines.push('');

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const roundEntries = history.filter(h => h.round === round);
    if (roundEntries.length === 0) continue;
    lines.push(`### ラウンド ${round}`);
    lines.push('');
    for (const entry of roundEntries) {
      lines.push(`【${entry.name}】`);
      lines.push('');
      lines.push(entry.content);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  // summarizer.jsが生成したサマリーがあれば末尾に追加
  if (summary && summary.summary) {
    lines.push('## 📝 会議まとめ(AI要約)');
    lines.push('');
    lines.push(summary.summary);
    lines.push('');
    if (summary.decisions && Array.isArray(summary.decisions) && summary.decisions.length > 0) {
      lines.push('### 決定事項');
      lines.push('');
      for (const d of summary.decisions) lines.push(`- ${d}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/** consultation_topicsをresolvedに更新(既存consultation.jsと同じロジック) */
async function _updateConsultationStatus(consultationId, resolution, env) {
  const sql = `
    UPDATE consultation_topics
    SET status = 'resolved',
        resolution = ?,
        resolved_at = datetime('now')
    WHERE id = ?
  `;
  await env.DB.prepare(sql).bind(resolution, consultationId).run();
}

/** リクエストのmodelsを正規化。未指定キーは安価なデフォルトで埋める */
function _resolveModels(inputModels) {
  const resolved = { ...DEFAULT_MODELS };
  if (inputModels && typeof inputModels === 'object') {
    for (const key of ['koko', 'onee', 'kuro']) {
      if (inputModels[key] && MODEL_MAP[key][inputModels[key]]) {
        resolved[key] = inputModels[key];
      }
    }
  }
  return resolved;
}
