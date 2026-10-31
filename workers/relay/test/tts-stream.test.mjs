// このファイルは何をするか: /gemini-tts の stream:true（生PCM）経路の単体テスト（上流fetchは全部モック・実APIには繋がない）
// 作成: 葵(Aoi) / 最終更新: 葵(Aoi), 2026-10-31
// 実行: node --test workers/relay/test/*.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { STREAM_LIMITS, audioFromSseLine, makePcmReader, buildStreamPayload } from '../relay-gemini-tts-stream.js';

const ORIGIN = 'https://akiyamanx.github.io';
const ENV = { ALLOWED_ORIGIN: ORIGIN, COCOMI_AUTH_TOKEN: 't', GEMINI_API_KEY: 'gk' };
const realFetch = globalThis.fetch;
const LIM0 = { ...STREAM_LIMITS };
let calls;
beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; Object.assign(STREAM_LIMITS, LIM0); });
const mockFetch = (h) => { globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return h(url, opts); }; };
const req = (body, extra = {}) => new Request('https://relay.example/gemini-tts', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-COCOMI-AUTH': 't' }, body: JSON.stringify(body), ...extra });
const b64 = (arr) => Buffer.from(Uint8Array.from(arr)).toString('base64');
const ev = (arr) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: b64(arr) } }] } }] })}\n\n`;
// 文字列の配列を「そのままの区切り」で流す上流の本文（cancel されたかも記録）
function sseBody(pieces, state = {}) {
  const enc = new TextEncoder(); let i = 0;
  return new ReadableStream({
    pull(c) { if (i < pieces.length) c.enqueue(enc.encode(pieces[i++])); else c.close(); },
    cancel() { state.cancelled = true; },
  });
}
const readAll = async (r) => new Uint8Array(await r.arrayBuffer());

test('stream: 公式の形で streamGenerateContent?alt=sse を呼び、audio/L16 を流す', async () => {
  mockFetch(() => new Response(sseBody([ev([1, 0, 2, 0]), ev([3, 0])]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  const r = await worker.fetch(req({ text: 'こんにちは', voice: 'Kore', style: 'cheerful', stream: true }), ENV);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'audio/L16; rate=24000; channels=1');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.equal(r.headers.get('Content-Encoding'), 'identity');
  assert.equal(r.headers.get('Content-Length'), null);
  assert.match(r.headers.get('Server-Timing'), /^upstream-ttfb;dur=\d+;desc="google headers", upstream-first;dur=\d+;desc="first audio"$/);
  assert.match(r.headers.get('Access-Control-Expose-Headers'), /Server-Timing/);
  assert.deepEqual([...await readAll(r)], [1, 0, 2, 0, 3, 0]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1beta\/models\/gemini-3\.8-flash-lite-tts:streamGenerateContent\?alt=sse$/);
  assert.equal(calls[0].opts.headers['x-goog-api-key'], 'gk');
  assert.deepEqual(JSON.parse(calls[0].opts.body), buildStreamPayload({ text: 'こんにちは', voice: 'Kore', style: 'cheerful' }));
  const p = JSON.parse(calls[0].opts.body);
  assert.deepEqual(p.generationConfig.speechConfig, { voiceConfig: { voice: 'Kore' } });
  assert.equal(p.contents[0].parts[0].speech_metadata.style, 'cheerful');
});

test('stream: 入力検証は unary と同じ（共通関数）・上流は呼ばない', async () => {
  mockFetch(() => { throw new Error('should not call'); });
  for (const b of [{ text: 'a', voice: 'nova' }, { text: 'a', voice: 'Kore', model: 'gpt' }, { text: 'a'.repeat(1501), voice: 'Kore' }, { text: '', voice: 'Kore' }]) {
    const r = await worker.fetch(req({ ...b, stream: true }), ENV);
    assert.equal(r.status, 400);
  }
  assert.equal(calls.length, 0);
});

test('stream: Origin/認証の門は同じ', async () => {
  mockFetch(() => { throw new Error('should not call'); });
  const bad = new Request('https://relay.example/gemini-tts', { method: 'POST', headers: { Origin: ORIGIN, 'X-COCOMI-AUTH': 'x' }, body: '{"text":"a","voice":"Kore","stream":true}' });
  assert.equal((await worker.fetch(bad, ENV)).status, 401);
  const evil = new Request('https://relay.example/gemini-tts', { method: 'POST', headers: { Origin: 'https://evil.example', 'X-COCOMI-AUTH': 't' }, body: '{}' });
  assert.equal((await worker.fetch(evil, ENV)).status, 403);
  assert.equal(calls.length, 0);
});

test('stream: SSE の行が chunk 境界で割れても・CRLF・event/コメント行でも組み立てる', async () => {
  const whole = ': ping\r\nevent: x\r\n' + ev([5, 0, 6, 0]).replace('\n\n', '\r\n\r\n') + ev([7, 0]);
  const pieces = []; for (let i = 0; i < whole.length; i += 7) pieces.push(whole.slice(i, i + 7));
  const pcm = makePcmReader(sseBody(pieces));
  const got = []; let c; while ((c = await pcm.next())) got.push(...c);
  assert.deepEqual(got, [5, 0, 6, 0, 7, 0]);
  assert.deepEqual(audioFromSseLine('event: audio'), []); assert.deepEqual(audioFromSseLine('data: {broken'), []);
});

test('stream: 奇数バイトは最後の1バイトを次へ持ち越す（16bitの途中で切らない）', async () => {
  const pcm = makePcmReader(sseBody([ev([1, 2, 3]), ev([4, 5, 6, 7, 8])]));
  const a = await pcm.next(); const b = await pcm.next();
  assert.deepEqual([...a], [1, 2]); assert.deepEqual([...b], [3, 4, 5, 6, 7, 8]);
  assert.equal(await pcm.next(), null);
});

test('stream: 合計8MB（ここでは8バイト）を超えたら上流を reader.cancel()', async () => {
  STREAM_LIMITS.maxBytes = 8;
  const st = {};
  mockFetch(() => new Response(sseBody([ev([1, 0, 2, 0, 3, 0]), ev([4, 0, 5, 0, 6, 0]), ev([7, 0])], st), { status: 200 }));
  const r = await worker.fetch(req({ text: 'a', voice: 'Kore', stream: true }), ENV);
  assert.equal(r.status, 200);
  const rd = r.body.getReader(); const got = [];
  await assert.rejects(async () => { for (;;) { const { done, value } = await rd.read(); if (done) break; got.push(...value); } });
  assert.equal(got.length, 8); assert.equal(st.cancelled, true);
});

test('stream: クライアントが切ったら上流 fetch の signal も abort', async () => {
  let upSignal; const st = {};
  mockFetch((u, o) => { upSignal = o.signal; return new Response(sseBody([ev([1, 0]), ev([2, 0]), ev([3, 0])], st), { status: 200 }); });
  const ac = new AbortController();
  const r = await worker.fetch(req({ text: 'a', voice: 'Kore', stream: true }, { signal: ac.signal }), ENV);
  assert.equal(r.status, 200);
  const rd = r.body.getReader(); await rd.read();
  await rd.cancel();                                   // アプリの停止ボタン相当
  assert.equal(upSignal.aborted, true);
  const r2Sig = new AbortController();
  mockFetch((u, o) => { upSignal = o.signal; return new Response(sseBody([ev([1, 0])]), { status: 200 }); });
  const r2 = await worker.fetch(req({ text: 'a', voice: 'Kore', stream: true }, { signal: r2Sig.signal }), ENV);
  r2Sig.abort();                                       // request.signal 側の切断
  assert.equal(upSignal.aborted, true); await r2.body.cancel();
});

test('stream: 最初の音の前の失敗は定型JSON（上流エラー・届かない・0バイト・最初の音15秒）', async () => {
  mockFetch(() => new Response('secret detail', { status: 403 }));
  let r = await worker.fetch(req({ text: 'a', voice: 'Kore', stream: true }), ENV);
  assert.equal(r.status, 502); let j = await r.json(); assert.equal(j.upstream_status, 403); assert.ok(!JSON.stringify(j).includes('secret'));
  assert.match(r.headers.get('Content-Type'), /application\/json/); assert.equal(calls.length, 1);   // 再試行0

  mockFetch(() => { throw new TypeError('down'); });
  r = await worker.fetch(req({ text: 'a', voice: 'Kore', stream: true }), ENV);
  assert.equal(r.status, 504); assert.equal((await r.json()).error, 'Gemini TTS upstream unreachable');

  mockFetch(() => new Response(sseBody(['data: {"candidates":[]}\n\n']), { status: 200 }));
  r = await worker.fetch(req({ text: 'a', voice: 'Kore', stream: true }), ENV);
  assert.equal(r.status, 502); assert.equal((await r.json()).error, 'Gemini TTS upstream returned no audio');

  STREAM_LIMITS.firstChunkMs = 30;
  mockFetch((u, o) => new Response(new ReadableStream({ start(c) { o.signal.addEventListener('abort', () => c.error(new Error('aborted'))); } }), { status: 200 }));
  r = await worker.fetch(req({ text: 'a', voice: 'Kore', stream: true }), ENV);
  assert.equal(r.status, 504); assert.equal((await r.json()).error, 'Gemini TTS upstream timeout');
});

test('stream: 音の途中で無音10秒（ここでは30ms）なら流れを閉じる（status は200のまま）', async () => {
  STREAM_LIMITS.idleMs = 30;
  const enc = new TextEncoder();
  mockFetch((u, o) => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(ev([1, 0]))); o.signal.addEventListener('abort', () => c.error(new Error('aborted'))); } }), { status: 200 }));
  const r = await worker.fetch(req({ text: 'a', voice: 'Kore', stream: true }), ENV);
  assert.equal(r.status, 200);
  const rd = r.body.getReader();
  assert.deepEqual([...(await rd.read()).value], [1, 0]);
  await assert.rejects(rd.read());
});

test('stream: stream を付けない時は今まで通り interactions（unary 無変更）', async () => {
  mockFetch(() => new Response('x', { status: 500 }));
  const r = await worker.fetch(req({ text: 'a', voice: 'Kore' }), ENV);
  assert.equal(r.status, 500); assert.match(calls[0].url, /\/v1beta\/interactions$/);
});
