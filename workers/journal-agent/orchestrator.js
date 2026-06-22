// orchestrator.js
// COCOMI ジャーナリング自律エージェント - ループ司令塔（tool use × 最大10回 × 安全弁）
// Version: 1.0.0
// 設計書: cocomi-capsules/designs/ジャーナリング自律エージェント_統合設計書_v1.0_2026-06-19.md §2〜§5・§7・§9 準拠
//
// このファイルは何をするか:
//   1. 入力テキストを safety-check に通す（最優先）。red なら即座に危機レスポンスを返してループ終了。
//   2. green/yellow のときに Claude API tool use ループを回す（最大 MAX_LOOP_ITERATIONS 回）。
//      - 道具: get_current_time / search_memory / save_memory（実装は本ファイル末尾）
//      - 自律判断3点(★1〜★3)は AI に任せる
//   3. AI が最終 JSON（振り返り＋todo＋action）を返したらパースして journal_entries に1行保存。
//   4. 呼び出し元へ結果(zone, action, reflection, todo, journalId, trace) を返す。
//
// red 取扱（命に関わるため厳守）:
//   - raw_text を含め journal_entries に一切保存しない（設計書§6「本人OKまで残さない」）
//   - tool use ループを開始しない
//   - safety-check が組み立てた crisisResponse をそのまま返す
'use strict';

import {
  safetyCheck,
  SAFETY_DISCLAIMER,
} from './safety-check.js';
import {
  ORCHESTRATOR_SYSTEM_PROMPT,
  TOOLS_SCHEMA,
  buildOrchestratorUserMessage,
} from './prompts.js';

// ============================================================
// 定数
// ============================================================
const DEFAULT_MODEL = 'claude-sonnet-4-6';     // env.ORCHESTRATOR_MODEL で上書き可
const MAX_LOOP_ITERATIONS = 10;                // 設計書§4 安全弁
const MAX_TOKENS = 2000;
const TEMPERATURE = 0.3;                       // ツール判断は低め・振り返り文も安定寄り
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';

// ============================================================
// 公開関数: runJournalAgent
// ============================================================
/**
 * ジャーナリング自律エージェント本体。1件の入力テキストを最後まで処理する。
 * @param {object} env - Worker の env（ANTHROPIC_API_KEY, DB(D1), ORCHESTRATOR_MODEL?）
 * @param {string} inputText - アキヤが入力した今日の出来事の原文
 * @returns {Promise<object>} 結果オブジェクト（後段の整形・配信はこの上位レイヤーで）
 */
async function runJournalAgent(env, inputText) {
  const trace = { steps: [], iterations: 0 };

  // --- ステップ0: 安全チェック（最優先）---
  const safety = await safetyCheck(env, inputText);
  trace.safety = {
    zone: safety.zone,
    reasoning: safety.reasoning,
    model: safety.model,
    fallback: safety.fallback,
  };

  // --- red: 即座に危機レスポンスを返してループ終了。保存もToDoもしない。---
  if (safety.zone === 'red') {
    return {
      ok: true,
      zone: 'red',
      action: null,
      reflection: null,
      reflectionParts: null,
      todo: null,
      journalId: null,
      saved: false,
      crisisResponse: safety.crisisResponse,
      disclaimer: SAFETY_DISCLAIMER,
      trace,
    };
  }

  // --- green / yellow: tool use ループへ ---
  const messages = [
    {
      role: 'user',
      content: buildOrchestratorUserMessage(inputText, safety.zone, safety.reasoning),
    },
  ];

  let finalJson = null;
  let lastSaveAction = null;
  let lastSaveMemoryId = null;
  let stopReason = null;

  for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
    trace.iterations = i + 1;

    let resp;
    try {
      resp = await callClaudeWithTools(env, messages);
    } catch (err) {
      return {
        ok: false,
        zone: safety.zone,
        action: null,
        reflection: null,
        reflectionParts: null,
        todo: null,
        journalId: null,
        saved: false,
        error: 'orchestrator_api_error',
        errorDetail: shortenErr(err),
        disclaimer: SAFETY_DISCLAIMER,
        trace,
      };
    }

    const content = Array.isArray(resp.content) ? resp.content : [];
    messages.push({ role: 'assistant', content });

    const toolUses = content.filter((b) => b && b.type === 'tool_use');

    if (toolUses.length === 0) {
      // 道具を呼ばない＝最終応答。テキストを取り出して JSON パース。
      stopReason = resp.stop_reason || 'end_turn';
      const text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
        .trim();
      trace.finalRaw = text;
      const parsed = parseFinalJson(text);
      if (parsed.ok) {
        finalJson = parsed.value;
      } else {
        trace.parseError = parsed.detail;
      }
      break;
    }

    // ツール実行 → tool_result を user メッセージにまとめて返す
    const toolResults = [];
    for (const tu of toolUses) {
      const name = tu.name;
      const input = tu.input || {};
      const out = await executeTool(env, name, input);
      trace.steps.push({ tool: name, input, output: out });

      if (name === 'save_memory' && out && out.id) {
        lastSaveAction = normalizeAction(input.action);
        lastSaveMemoryId = out.id;
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(out),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // --- ループが最大回数で抜けた / 最終JSONがパースできなかった ---
  if (!finalJson) {
    return {
      ok: false,
      zone: safety.zone,
      action: lastSaveAction,
      reflection: null,
      reflectionParts: null,
      todo: null,
      journalId: null,
      saved: false,
      error: trace.parseError ? 'orchestrator_parse_error' : 'orchestrator_max_iterations',
      stopReason,
      disclaimer: SAFETY_DISCLAIMER,
      trace,
    };
  }

  // --- 振り返りテキスト合成 + journal_entries 保存 ---
  const reflectionParts = {
    facts: stringOrNull(finalJson.reflection_facts),
    reframe: stringOrNull(finalJson.reflection_reframe),
    empathy: stringOrNull(finalJson.empathy),
  };
  const reflection = composeReflectionText(reflectionParts);
  const todo = stringOrNull(finalJson.todo);
  const action = normalizeAction(finalJson.action) || lastSaveAction || null;

  const journalId = makeId();
  const date = todayJST();
  let saved = false;
  try {
    if (env && env.DB && typeof env.DB.prepare === 'function') {
      await env.DB.prepare(
        'INSERT INTO journal_entries (id, date, raw_text, zone, action, reflection, todo) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(journalId, date, inputText, safety.zone, action, reflection, todo)
        .run();
      saved = true;
    } else {
      trace.dbError = 'no DB binding (likely demo/mock mode)';
    }
  } catch (e) {
    trace.dbError = shortenErr(e);
  }

  return {
    ok: true,
    zone: safety.zone,
    action,
    reflection,
    reflectionParts,
    todo,
    journalId: saved ? journalId : null,
    saved,
    saveMemoryId: lastSaveMemoryId,
    note: stringOrNull(finalJson.note),
    disclaimer: SAFETY_DISCLAIMER,
    trace,
  };
}

// ============================================================
// 内部: Claude API 呼び出し（tools 付き）
// ============================================================
async function callClaudeWithTools(env, messages) {
  const apiKey = env && env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY が env に設定されていません');
  }
  const model = (env && env.ORCHESTRATOR_MODEL) || DEFAULT_MODEL;

  const body = {
    model,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: ORCHESTRATOR_SYSTEM_PROMPT,
    tools: TOOLS_SCHEMA,
    messages,
  };

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
  }
  return await res.json();
}

// ============================================================
// 内部: ツール実装（最小・MVP）
//   - get_current_time: ローカルで時刻計算
//   - search_memory   : MVP は空結果（既存 memories テーブルに触らない）
//   - save_memory     : MVP は意思表明のみ受領（実体は最終ステップで journal_entries に保存）
// ============================================================
async function executeTool(env, name, input) {
  try {
    if (name === 'get_current_time') return toolGetCurrentTime();
    if (name === 'search_memory') return await toolSearchMemory(env, input);
    if (name === 'save_memory') return await toolSaveMemory(env, input);
    return { ok: false, error: `unknown_tool:${name}` };
  } catch (e) {
    return { ok: false, error: 'tool_exception', detail: shortenErr(e) };
  }
}

function toolGetCurrentTime() {
  const now = new Date();
  const jstMs = now.getTime() + 9 * 60 * 60 * 1000;
  const jst = new Date(jstMs);
  const isoUtc = now.toISOString();
  const isoJst = jst.toISOString().replace('Z', '+09:00');
  const dateJst = jst.toISOString().slice(0, 10);
  const weekdayJst = ['日', '月', '火', '水', '木', '金', '土'][jst.getUTCDay()];
  return {
    ok: true,
    jst: isoJst,
    utc: isoUtc,
    date: dateJst,
    weekday: weekdayJst,
  };
}

async function toolSearchMemory(env, input) {
  // MVP: 既存 memories テーブルに触らない（後で cocomi-mcp-server 経由に差し替える）
  const query = (input && typeof input.query === 'string') ? input.query : '';
  const limit = (input && Number.isFinite(input.limit)) ? input.limit : 3;
  return {
    ok: true,
    results: [],
    note: 'MVP stub: 既存 memories は触らない。後続フェーズで cocomi-mcp-server 経由に差し替え予定。',
    query,
    limit,
  };
}

async function toolSaveMemory(env, input) {
  // MVP: 実体保存は orchestrator 最終ステップで journal_entries に1行作る。
  // ここは AI が保存意思を表明したことを受け取り、id を返すのみ。
  const id = makeId();
  const action = normalizeAction(input && input.action);
  const text = (input && typeof input.text === 'string') ? input.text : '';
  return {
    ok: true,
    id,
    accepted: true,
    action,
    category: (input && typeof input.category === 'string') ? input.category : null,
    text_preview: text.slice(0, 80),
    note: 'MVP: 実体は journal_entries 行で記録される。',
  };
}

// ============================================================
// 内部: ユーティリティ
// ============================================================
function parseFinalJson(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, detail: 'empty text' };
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return { ok: false, detail: 'no JSON braces' };
  }
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (!obj || typeof obj !== 'object') return { ok: false, detail: 'not object' };
    return { ok: true, value: obj };
  } catch (e) {
    return { ok: false, detail: `JSON.parse failed: ${shortenErr(e)}` };
  }
}

function composeReflectionText(parts) {
  const out = [];
  if (parts.empathy) out.push(parts.empathy);
  if (parts.reflection_facts || parts.facts) {
    out.push(`【事実】${parts.reflection_facts || parts.facts}`);
  }
  if (parts.reflection_reframe || parts.reframe) {
    out.push(`【捉え直し】${parts.reflection_reframe || parts.reframe}`);
  }
  return out.join('\n\n');
}

function normalizeAction(a) {
  return a === 'memory' || a === 'safezone' ? a : null;
}

function stringOrNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  if (t.toLowerCase() === 'null') return null;
  return t;
}

function todayJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'je_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function shortenErr(err) {
  if (!err) return '';
  if (typeof err === 'string') return err.slice(0, 300);
  const msg = (err && (err.message || String(err))) || '';
  return msg.slice(0, 300);
}

// ============================================================
// エクスポート
// ============================================================
export {
  runJournalAgent,
  MAX_LOOP_ITERATIONS,
  DEFAULT_MODEL,
};
