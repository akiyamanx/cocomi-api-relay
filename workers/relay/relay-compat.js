// このファイルは何をするか:
// OpenAI互換 Chat Completions 形式の外部API（xAI Grok = /xai、Moonshot Kimi = /kimi）の中継。
// 本文は許可リスト方式で組み立て直し（知らないキーは捨てる）、上流へ1回だけ送り、上流の応答をそのまま返す。
// 作成: 葵(Aoi) / 最終更新: 葵(Aoi), 2026-10-30
// v1.0 2026-10-30 - 新規作成（アプリ側 api-xai.js / api-kimi.js / api-compat-core.js の送信形に合わせる）
//   - シークレット: env.XAI_API_KEY / env.KIMI_API_KEY（未設定なら JSON の 500 エラー）
//   - stream は拒否 / tools は type:function のみ最大8個 / tool_choice は auto|none
//   - messages.role は system|user|assistant|tool。tool_calls / tool_call_id は残す
//   - max_completion_tokens は 1〜32000 の整数（超えたら 400）
//   - 再試行しない（fetchWithRetry は使わない）。上流のステータス・本文・Content-Type はそのまま返す
import { jsonError } from './utils.js';

export const COMPAT_ENDPOINTS = {
  xai: 'https://api.x.ai/v1/chat/completions',
  kimi: 'https://api.moonshot.ai/v1/chat/completions',
};

// アプリの model-tiers.js（xai / moonshot）にあるモデル＋近い世代。増減はここだけ（フェイルクローズ）
const ALLOWED_MODELS = {
  xai: new Set(['grok-4.3', 'grok-4.5', 'grok-4.6', 'grok-4.7']),
  kimi: new Set(['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3']),
};
const KEY_NAMES = { xai: 'XAI_API_KEY', kimi: 'KIMI_API_KEY' };

export const MAX_COMPLETION_TOKENS = 32000;
export const MAX_TOOLS = 8;
const MAX_MESSAGES = 200;
const MAX_BODY_BYTES = 1024 * 1024;
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const TOOL_CHOICES = new Set(['auto', 'none']);
const EFFORT_RE = /^[a-z_]{1,16}$/;
const MSG_KEYS = ['role', 'content', 'name', 'tool_calls', 'tool_call_id'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 1件のメッセージを許可キーだけで作り直す。不正なら文字列（エラー文）を返す */
function cleanMessage(m) {
  if (!isPlainObject(m) || !ROLES.has(m.role)) return 'Invalid message role';
  const out = {};
  for (const k of MSG_KEYS) if (m[k] !== undefined) out[k] = m[k];
  if (out.tool_calls !== undefined && !Array.isArray(out.tool_calls)) return 'tool_calls must be an array';
  if (out.tool_call_id !== undefined && typeof out.tool_call_id !== 'string') return 'tool_call_id must be a string';
  return out;
}

/** tools を type:function のみ・最大8個で作り直す。不正なら文字列 */
function cleanTools(tools) {
  if (!Array.isArray(tools)) return 'tools must be an array';
  if (tools.length > MAX_TOOLS) return `tools must be at most ${MAX_TOOLS}`;
  const out = [];
  for (const t of tools) {
    if (!isPlainObject(t) || t.type !== 'function' || !isPlainObject(t.function)) return 'Only function tools are allowed';
    const f = t.function;
    if (typeof f.name !== 'string' || !f.name) return 'tool function name is required';
    const fn = { name: f.name };
    if (typeof f.description === 'string') fn.description = f.description;
    if (isPlainObject(f.parameters)) fn.parameters = f.parameters;
    if (typeof f.strict === 'boolean') fn.strict = f.strict;
    out.push({ type: 'function', function: fn });
  }
  return out;
}

/**
 * 受け取った本文から上流へ送る本文を作る（純関数・テスト用に export）。
 * 戻り値: { body } または { error: 'メッセージ' }
 */
export function buildCompatBody(provider, input) {
  if (!isPlainObject(input)) return { error: 'Body must be a JSON object' };
  if (input.stream !== undefined && input.stream !== false) return { error: 'stream is not supported' };
  if (typeof input.model !== 'string' || !ALLOWED_MODELS[provider].has(input.model)) {
    return { error: `Model not allowed: ${String(input.model).slice(0, 64)}` };
  }
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > MAX_MESSAGES) {
    return { error: `messages must be an array of 1..${MAX_MESSAGES}` };
  }
  const body = { model: input.model, messages: [] };
  for (const m of input.messages) {
    const c = cleanMessage(m);
    if (typeof c === 'string') return { error: c };
    body.messages.push(c);
  }
  if (input.max_completion_tokens !== undefined) {
    const n = input.max_completion_tokens;
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_COMPLETION_TOKENS) {
      return { error: `max_completion_tokens must be an integer 1..${MAX_COMPLETION_TOKENS}` };
    }
    body.max_completion_tokens = n;
  }
  if (input.reasoning_effort !== undefined) {
    if (typeof input.reasoning_effort !== 'string' || !EFFORT_RE.test(input.reasoning_effort)) return { error: 'Invalid reasoning_effort' };
    body.reasoning_effort = input.reasoning_effort;
  }
  if (input.tools !== undefined) {
    const t = cleanTools(input.tools);
    if (typeof t === 'string') return { error: t };
    if (t.length) body.tools = t;
  }
  if (input.tool_choice !== undefined) {
    if (!TOOL_CHOICES.has(input.tool_choice)) return { error: 'tool_choice must be "auto" or "none"' };
    body.tool_choice = input.tool_choice;
  }
  return { body };
}

async function relayCompat(provider, request, env) {
  const keyName = KEY_NAMES[provider];
  const apiKey = env[keyName];
  if (!apiKey) return jsonError(`${keyName} is not configured on the relay`, 500);

  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return jsonError('Request body too large', 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return jsonError('Request body too large', 413);
  let input;
  try { input = JSON.parse(raw); } catch { return jsonError('Invalid JSON', 400); }
  const built = buildCompatBody(provider, input);
  if (built.error) return jsonError(built.error, 400);

  // 再試行なし: 1回だけ送り、上流の応答（ステータス・本文・Content-Type）をそのまま返す
  let res;
  try {
    res = await fetch(COMPAT_ENDPOINTS[provider], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(built.body),
    });
  } catch {
    return jsonError(`${provider} upstream unreachable`, 502);
  }
  const headers = new Headers();
  headers.set('Content-Type', res.headers.get('Content-Type') || 'application/json');
  return new Response(res.body, { status: res.status, headers });
}

export function relayXai(request, env) { return relayCompat('xai', request, env); }
export function relayKimi(request, env) { return relayCompat('kimi', request, env); }
