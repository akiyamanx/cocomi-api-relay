// このファイルは何をするか:
// /gemini-tts の「受け取りながら」版（body.stream===true の時だけ）。Google の streamGenerateContent(SSE) の音声を
// 生PCM（audio/L16, 24kHz, mono, 16bit little-endian）のまま流す。入力検証は relay-gemini-tts.js の readTTSRequest() を共用
// 作成: 葵(Aoi) / 最終更新: 葵(Aoi), 2026-10-31
// v1.0 2026-10-31 - 新規作成（クロ検収 §3 案A の Red 条件 1〜6 に沿う）
//   - 上流: POST /v1beta/models/{model}:streamGenerateContent?alt=sse（ヘッダ x-goog-api-key）。再試行しない
//   - 最初の音まで15秒（それまでは status 前なので定型JSON 504）／チャンク間の無音10秒＋全体120秒（以降は流れを閉じるだけ）
//   - 合計8MBで上流を reader.cancel()。クライアント切断（request.signal / 返却 stream の cancel）で上流 fetch も止める
//   - SSE は TextDecoder(stream) で改行まで貯める。base64 復号後のバイト数が奇数なら最後の1バイトを次へ持ち越す
import { jsonError } from './utils.js';
import { upstreamError } from './relay-gemini-tts.js';

// 出典: ai.google.dev/gemini-api/docs/generate-content/speech-generation「Streaming speech generation」（2026-10-31閲覧）
const STREAM_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
export const PCM_CONTENT_TYPE = 'audio/L16; rate=24000; channels=1';
// テストから縮められるように export（本番では書き換えない）
export const STREAM_LIMITS = { firstChunkMs: 15000, idleMs: 10000, totalMs: 120000, maxBytes: 8 * 1024 * 1024 };

export function buildStreamPayload({ text, voice, style }) {
  const part = { text };
  if (style) part.speech_metadata = { style };
  return {
    contents: [{ role: 'user', parts: [part] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      responseFormat: { audio: { mimeType: 'AUDIO_L16', sampleRate: 24000 } },   // ストリームの既定と同じ。明示しておく
      speechConfig: { voiceConfig: { voice } },
    },
  };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// SSE 1行（data: {...}）から音声の base64 を全部取り出す。音声以外・壊れた行は []
export function audioFromSseLine(line) {
  if (!line.startsWith('data:')) return [];       // event: / :コメント / 空行は捨てる
  let j;
  try { j = JSON.parse(line.slice(5).trim()); } catch { return []; }
  const out = [];
  for (const c of Array.isArray(j?.candidates) ? j.candidates : []) {
    for (const p of Array.isArray(c?.content?.parts) ? c.content.parts : []) {
      const d = (p && (p.inlineData || p.inline_data)) || null;
      if (d && typeof d.data === 'string' && d.data) out.push(d.data);
    }
  }
  return out;
}

// 上流の SSE 本文 → PCM のかたまりを1つずつ返す読み手（奇数バイト持ち越し・8MB上限つき）
export function makePcmReader(body, { maxBytes = STREAM_LIMITS.maxBytes, onRead = () => {} } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '', carry = null, total = 0, done = false, capped = false;
  const queue = [];
  const push = (b64) => {
    let bytes;
    try { bytes = b64ToBytes(b64); } catch { return; }
    if (carry) { const m = new Uint8Array(carry.length + bytes.length); m.set(carry); m.set(bytes, carry.length); bytes = m; carry = null; }
    if (bytes.length % 2) { carry = bytes.slice(-1); bytes = bytes.subarray(0, bytes.length - 1); }
    if (total + bytes.length > maxBytes) { bytes = bytes.subarray(0, (maxBytes - total) & ~1); capped = true; }
    total += bytes.length;
    if (bytes.length) queue.push(bytes);
  };
  const eatLines = (final) => {
    const lines = buf.split('\n');
    buf = final ? '' : (lines.pop() || '');
    for (const l of lines) for (const b of audioFromSseLine(l.replace(/\r$/, ''))) { if (!capped) push(b); }
  };
  return {
    get total() { return total; },
    get capped() { return capped; },
    async next() {                                  // Uint8Array（偶数バイト）か null（終わり）
      while (!queue.length && !done) {
        if (capped) { done = true; try { await reader.cancel(); } catch { /* 既に閉じている */ } break; }
        const { done: d, value } = await reader.read();
        onRead();
        if (d) { buf += decoder.decode(); eatLines(true); done = true; break; }
        buf += decoder.decode(value, { stream: true });
        eatLines(false);
      }
      return queue.length ? queue.shift() : null;
    },
    async cancel() { done = true; try { await reader.cancel(); } catch { /* ignore */ } },
  };
}

export async function relayGeminiTTSStream(request, env, v) {
  const L = STREAM_LIMITS;
  const ctrl = new AbortController();               // 上流を止めるのはこれ1つ（切断・時間切れ・上限）
  let why = null;
  const stop = (r) => { if (!why) why = r; ctrl.abort(); };
  const sig = request.signal;
  if (sig) { if (sig.aborted) stop('client'); else sig.addEventListener('abort', () => stop('client'), { once: true }); }
  const t0 = Date.now();
  const totalTimer = setTimeout(() => stop('total'), L.totalMs);
  let firstTimer = setTimeout(() => stop('first'), L.firstChunkMs);
  let idleTimer = null;
  const clearAll = () => { clearTimeout(totalTimer); clearTimeout(firstTimer); clearTimeout(idleTimer); };
  const timeoutJson = () => {
    const r = jsonError(why === 'first' || why === 'total' ? 'Gemini TTS upstream timeout' : 'Gemini TTS upstream unreachable', 504);
    r.headers.set('Server-Timing', `upstream;dur=${Date.now() - t0};desc="google total"`);
    return r;
  };

  let res;
  try {
    res = await fetch(`${STREAM_BASE}${encodeURIComponent(v.model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(buildStreamPayload(v)),
      signal: ctrl.signal,
    });
  } catch { clearAll(); return timeoutJson(); }
  const ttfb = Date.now() - t0;
  if (!res.ok || !res.body) {
    clearAll();
    try { await res.body?.cancel(); } catch { /* ignore */ }
    const e = upstreamError(res.ok ? 502 : res.status);
    e.headers.set('Server-Timing', `upstream-ttfb;dur=${ttfb};desc="google headers"`);
    return e;
  }

  const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => stop('idle'), L.idleMs); };
  const pcm = makePcmReader(res.body, { maxBytes: L.maxBytes, onRead: armIdle });
  // 最初の音が来るまでは status を返さない（ここまでの失敗は今と同じ定型JSON）
  let first;
  try { first = await pcm.next(); } catch { clearAll(); await pcm.cancel(); return timeoutJson(); }
  clearTimeout(firstTimer); firstTimer = null;
  if (!first) { clearAll(); return jsonError('Gemini TTS upstream returned no audio', 502); }
  const tFirst = Date.now() - t0;
  armIdle();

  let pending = first;
  const out = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = pending || await pcm.next();
        pending = null;
        if (chunk) { controller.enqueue(chunk); return; }
        clearAll();
        // 8MB上限で切った時は「途中で切れた」扱い（アプリ側 truncated）。普通に終わったら close
        if (pcm.capped) controller.error(new Error('audio too large')); else controller.close();
      } catch (e) {
        clearAll(); await pcm.cancel();
        controller.error(new Error(`stream ended: ${why || 'upstream'}`));   // status 200 は返し済み。流れを閉じるだけ
      }
    },
    async cancel() { stop('client'); clearAll(); await pcm.cancel(); },   // アプリが停止→上流も止める
  });
  return new Response(out, {
    status: 200,
    headers: {
      'Content-Type': PCM_CONTENT_TYPE, 'Cache-Control': 'no-store', 'Content-Encoding': 'identity',
      'Server-Timing': `upstream-ttfb;dur=${ttfb};desc="google headers", upstream-first;dur=${tFirst};desc="first audio"`,
    },
  });
}
