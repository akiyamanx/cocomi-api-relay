// このファイルは何をするか: /xai /kimi /gemini-tts 中継の単体テスト（node --test。上流fetchは全部モック・実APIには繋がない）
// 作成: 葵(Aoi) / 最終更新: 葵(Aoi), 2026-10-31
// 実行: node --test workers/relay/test/
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { buildCompatBody, COMPAT_ENDPOINTS } from '../relay-compat.js';

const ORIGIN = 'https://akiyamanx.github.io';
const ENV = { ALLOWED_ORIGIN: ORIGIN, COCOMI_AUTH_TOKEN: 't', XAI_API_KEY: 'xk', KIMI_API_KEY: 'kk', GEMINI_API_KEY: 'gk' };
const realFetch = globalThis.fetch;
let calls;

function mockFetch(handler) {
  globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return handler(url, opts); };
}
beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

function req(path, body, { origin = ORIGIN, auth = 't', method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: origin };
  if (auth) headers['X-COCOMI-AUTH'] = auth;
  return new Request('https://relay.example' + path, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined });
}
// アプリの api-compat-core.js が送る形
const appBody = (model) => ({ model, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }], reasoning_effort: 'low', max_completion_tokens: 8192 });

// ---- Origin / 認証（既存チェックの内側にあること） ----
for (const p of ['/xai', '/kimi', '/gemini-tts']) {
  test(`${p}: 許可外Originは403、上流は呼ばない`, async () => {
    mockFetch(() => { throw new Error('should not call'); });
    const r = await worker.fetch(req(p, {}, { origin: 'https://evil.example' }), ENV);
    assert.equal(r.status, 403); assert.equal(calls.length, 0);
  });
  test(`${p}: 認証トークン違いは401`, async () => {
    mockFetch(() => { throw new Error('should not call'); });
    const r = await worker.fetch(req(p, {}, { auth: 'bad' }), ENV);
    assert.equal(r.status, 401); assert.equal(calls.length, 0);
  });
  test(`${p}: GETは405`, async () => {
    const r = await worker.fetch(req(p, null, { method: 'GET' }), ENV);
    assert.equal(r.status, 405);
  });
}

// ---- キー未設定 ----
for (const [p, key, body] of [['/xai', 'XAI_API_KEY', appBody('grok-4.3')], ['/kimi', 'KIMI_API_KEY', appBody('kimi-k3.1-pro')],
  ['/gemini-tts', 'GEMINI_API_KEY', { text: 'こんにちは', voice: 'Kore' }]]) {
  test(`${p}: ${key} 未設定はJSONエラー500`, async () => {
    mockFetch(() => { throw new Error('should not call'); });
    const env = { ...ENV }; delete env[key];
    const r = await worker.fetch(req(p, body), env);
    assert.equal(r.status, 500);
    const j = await r.json();
    assert.match(j.error, new RegExp(key));
    assert.equal(calls.length, 0);
  });
}

// ---- xAI / Kimi 中継 ----
for (const [p, prov, model, key] of [['/xai', 'xai', 'grok-4.7', 'xk'], ['/kimi', 'kimi', 'kimi-k3.1-pro', 'kk']]) {
  test(`${p}: アプリの送信形をそのまま上流へ1回だけ送り、応答を無変更で返す`, async () => {
    const upstream = '{"id":"x","choices":[{"message":{"content":"やあ"}}],"usage":{"prompt_tokens":1}}';
    mockFetch(() => new Response(upstream, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
    const r = await worker.fetch(req(p, appBody(model)), ENV);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), upstream);
    assert.equal(r.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, COMPAT_ENDPOINTS[prov]);
    assert.equal(calls[0].opts.headers.Authorization, `Bearer ${key}`);
    assert.deepEqual(JSON.parse(calls[0].opts.body), appBody(model));
  });
  test(`${p}: 上流429は再試行せずそのまま返す`, async () => {
    mockFetch(() => new Response('{"error":{"message":"rate"}}', { status: 429, headers: { 'Content-Type': 'application/json' } }));
    const r = await worker.fetch(req(p, appBody(model)), ENV);
    assert.equal(r.status, 429); assert.equal(calls.length, 1);
    assert.equal(await r.text(), '{"error":{"message":"rate"}}');
  });
  test(`${p}: stream:true は400で上流を呼ばない`, async () => {
    mockFetch(() => { throw new Error('should not call'); });
    const r = await worker.fetch(req(p, { ...appBody(model), stream: true }), ENV);
    assert.equal(r.status, 400); assert.equal(calls.length, 0);
  });
}

// ---- 許可リスト（純関数） ----
const base = appBody('grok-4.3');
const fn = (name) => ({ type: 'function', function: { name, description: 'd', parameters: { type: 'object' } } });
test('知らないキーは捨てる（トップ・message・tool）', () => {
  const { body } = buildCompatBody('xai', { ...base, temperature: 1, search_parameters: {}, foo: 1,
    messages: [{ role: 'user', content: 'a', extra: 1, reasoning_content: 'r' }], tools: [{ ...fn('f'), x: 1 }] });
  assert.deepEqual(Object.keys(body).sort(), ['max_completion_tokens', 'messages', 'model', 'reasoning_effort', 'tools']);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'a' }]);
  assert.deepEqual(body.tools, [fn('f')]);
});
test('tool_calls と tool_call_id は残す', () => {
  const tc = [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }];
  const { body } = buildCompatBody('kimi', { model: 'kimi-k3.1-pro', messages: [
    { role: 'user', content: 'q' }, { role: 'assistant', content: null, tool_calls: tc }, { role: 'tool', tool_call_id: 'c1', content: 'ok' }] });
  assert.deepEqual(body.messages[1].tool_calls, tc);
  assert.equal(body.messages[2].tool_call_id, 'c1');
});
test('role は system/user/assistant/tool のみ', () => {
  for (const role of ['developer', 'function', undefined]) {
    assert.ok(buildCompatBody('xai', { ...base, messages: [{ role, content: 'a' }] }).error);
  }
});
test('tools は function のみ・最大8個', () => {
  assert.ok(buildCompatBody('xai', { ...base, tools: Array.from({ length: 8 }, (_, i) => fn('f' + i)) }).body);
  assert.ok(buildCompatBody('xai', { ...base, tools: Array.from({ length: 9 }, (_, i) => fn('f' + i)) }).error);
  assert.ok(buildCompatBody('xai', { ...base, tools: [{ type: 'web_search' }] }).error);
  assert.ok(buildCompatBody('xai', { ...base, tools: {} }).error);
});
test('tool_choice は auto/none のみ', () => {
  assert.equal(buildCompatBody('xai', { ...base, tool_choice: 'auto' }).body.tool_choice, 'auto');
  assert.equal(buildCompatBody('xai', { ...base, tool_choice: 'none' }).body.tool_choice, 'none');
  for (const c of ['required', { type: 'function', function: { name: 'f' } }]) assert.ok(buildCompatBody('xai', { ...base, tool_choice: c }).error);
});
test('max_completion_tokens は 32000 まで', () => {
  assert.equal(buildCompatBody('xai', { ...base, max_completion_tokens: 32000 }).body.max_completion_tokens, 32000);
  for (const n of [32001, 0, 1.5, '100']) assert.ok(buildCompatBody('xai', { ...base, max_completion_tokens: n }).error);
});
test('stream は false/未指定のみ', () => {
  assert.ok(buildCompatBody('xai', { ...base, stream: false }).body);
  assert.equal('stream' in buildCompatBody('xai', { ...base, stream: false }).body, false);
  assert.ok(buildCompatBody('xai', { ...base, stream: true }).error);
});
test('許可外モデル・messages不正は拒否', () => {
  assert.ok(buildCompatBody('xai', { ...base, model: 'kimi-k3.1-pro' }).error);
  assert.ok(buildCompatBody('kimi', { ...base, model: 'grok-4.3' }).error);
  assert.ok(buildCompatBody('xai', { ...base, messages: [] }).error);
});

// ---- Gemini TTS ----
function wavB64() {
  const b = new Uint8Array(48); b.set([0x52, 0x49, 0x46, 0x46]); return Buffer.from(b).toString('base64');
}
test('/gemini-tts: アプリの送信形 → interactions へ1回、WAVを返す', async () => {
  mockFetch(() => new Response(JSON.stringify({ steps: [{ content: [{ type: 'audio', data: wavB64() }] }] }), { status: 200 }));
  const r = await worker.fetch(req('/gemini-tts', { text: 'こんにちは', voice: 'Kore', model: 'gemini-3.8-flash-lite-tts', style: 'cheerful' }), ENV);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'audio/wav');
  assert.equal((await r.arrayBuffer()).byteLength, 48);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1beta\/interactions$/);
  assert.equal(calls[0].opts.headers['x-goog-api-key'], 'gk');
  const sent = JSON.parse(calls[0].opts.body);
  assert.equal(sent.model, 'gemini-3.8-flash-lite-tts');
  assert.deepEqual(sent.generation_config, { speech_config: [{ voice: 'Kore' }] });
  assert.equal(sent.input[0].content[0].annotations[0].style, 'cheerful');
  assert.match(r.headers.get('Server-Timing'), /^upstream-ttfb;dur=\d+;desc="google headers", upstream;dur=\d+;desc="google total"$/);
  assert.match(r.headers.get('Access-Control-Expose-Headers'), /Server-Timing/);
});
test('/gemini-tts: 入力検証（声・モデル・長さ）', async () => {
  mockFetch(() => { throw new Error('should not call'); });
  for (const b of [{ text: 'a', voice: 'nova' }, { text: 'a', voice: 'Kore', model: 'gpt' }, { text: 'a'.repeat(1501), voice: 'Kore' },
    { text: '', voice: 'Kore' }, { text: 'a', voice: 'Kore', style: 'x'.repeat(201) }]) {
    const r = await worker.fetch(req('/gemini-tts', b), ENV);
    assert.equal(r.status, 400);
  }
  assert.equal(calls.length, 0);
});
test('/gemini-tts: 上流エラーは再試行せず定型JSON（401→502）', async () => {
  mockFetch(() => new Response('secret detail', { status: 401 }));
  const r = await worker.fetch(req('/gemini-tts', { text: 'a', voice: 'Kore' }), ENV);
  assert.equal(r.status, 502); assert.equal(calls.length, 1);
  assert.match(r.headers.get('Server-Timing'), /^upstream-ttfb;dur=\d+;desc="google headers", upstream;dur=\d+;desc="google total"$/);
  const j = await r.json(); assert.equal(j.upstream_status, 401); assert.ok(!JSON.stringify(j).includes('secret'));
});
test('/gemini-tts: 上流に届かない時は504＋upstream の時間だけ', async () => {
  mockFetch(() => { throw new TypeError('network down'); });
  const r = await worker.fetch(req('/gemini-tts', { text: 'a', voice: 'Kore' }), ENV);
  assert.equal(r.status, 504);
  assert.match(r.headers.get('Server-Timing'), /^upstream;dur=\d+;desc="google total"$/);
});

// ---- 既存ルートは従来どおり ----
test('未知のパスは従来どおり404', async () => {
  const r = await worker.fetch(req('/nope', {}), ENV);
  assert.equal(r.status, 404);
});

// ---- 読み上げ専用の鍵 ----
test('GEMINI_TTS_API_KEY があれば /gemini-tts はそれを使い、/gemini は GEMINI_API_KEY のまま', async () => {
  const env = { ...ENV, GEMINI_TTS_API_KEY: 'tk' };
  mockFetch(() => new Response(JSON.stringify({ steps: [{ content: [{ type: 'audio', data: wavB64() }] }] }), { status: 200 }));
  const r = await worker.fetch(req('/gemini-tts', { text: 'こんにちは', voice: 'Kore' }), env);
  assert.equal(r.status, 200);
  assert.equal(calls[0].opts.headers['x-goog-api-key'], 'tk');
  calls = [];
  mockFetch(() => new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
  await worker.fetch(req('/gemini', { contents: [{ parts: [{ text: 'hi' }] }] }), env);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /key=gk/);
  assert.doesNotMatch(calls[0].url, /tk/);
});
