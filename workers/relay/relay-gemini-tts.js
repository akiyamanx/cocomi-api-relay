// このファイルは何をするか:
// /gemini-tts の中継。アプリ側 gemini-tts-provider.js（{ text, voice, model, style? } を送り WAV を受け取る）に合わせる。
// 作成: 葵(Aoi) / 最終更新: 葵(Aoi), 2026-10-30
// v1.0 2026-10-30 - 新規作成（提案ドラフト relay-audio.js の /gemini-tts 部分を独立ファイル化。/whisper は変更しない）
//   - 許可モデル2種・許可声30種・text 1500字・style 200字まで。シークレットは既存の env.GEMINI_API_KEY
//   - 上流は POST /v1beta/interactions（ヘッダ x-goog-api-key）。応答の最後の audio ブロックを audio/wav で返す
//   - 再試行しない・タイムアウト60秒。上流エラーは定型文＋upstream_status のみ（401/403 は 502）
import { jsonError } from './utils.js';

// 出典: ai.google.dev/gemini-api/docs/speech-generation（2026-10-28閲覧）。増減はここだけ
const TTS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const TTS_MODELS = new Set(['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts']);
const DEFAULT_TTS_MODEL = 'gemini-3.8-flash-lite-tts';
const TTS_VOICES = new Set(['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat']);
const MAX_TEXT = 1500;
const MAX_STYLE = 200;
const MAX_BODY_BYTES = 16 * 1024;
const TTS_TIMEOUT_MS = 60000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;   // 約3分(24kHz/16bit)。想定外に大きい応答は返さない


const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function upstreamError(status) {
  const out = (status === 401 || status === 403) ? 502 : (status >= 400 && status < 600 ? status : 502);
  return new Response(JSON.stringify({ error: 'Gemini TTS upstream error', upstream_status: status }), {
    status: out, headers: { 'Content-Type': 'application/json' },
  });
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 生PCM(L16/24kHz/mono)だった場合に備えてWAVヘッダを付ける（公式の非ストリーム応答はWAV済みなので通常は通らない）
function wrapPcmAsWav(pcm) {
  const h = new DataView(new ArrayBuffer(44));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); h.setUint32(4, 36 + pcm.length, true); w(8, 'WAVEfmt '); h.setUint32(16, 16, true);
  h.setUint16(20, 1, true); h.setUint16(22, 1, true); h.setUint32(24, 24000, true); h.setUint32(28, 48000, true);
  h.setUint16(32, 2, true); h.setUint16(34, 16, true); w(36, 'data'); h.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(h.buffer), 0); out.set(pcm, 44);
  return out;
}

const isRiff = (b) => b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46;

// steps[].content[] の type:"audio" の最後のブロックの data（無ければ null）
export function lastAudioData(j) {
  let data = null;
  for (const step of Array.isArray(j?.steps) ? j.steps : []) {
    for (const c of Array.isArray(step?.content) ? step.content : []) {
      if (c && c.type === 'audio' && typeof c.data === 'string' && c.data) data = c.data;
    }
  }
  return data;
}

export async function relayGeminiTTS(request, env) {
  if (!env.GEMINI_API_KEY) return jsonError('GEMINI_API_KEY is not configured', 500);
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return jsonError('Request body too large', 413);
  let body;
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return jsonError('Request body too large', 413);   // Content-Lengthなし(chunked)でも効かせる
  try { body = JSON.parse(raw); } catch { return jsonError('Invalid JSON body', 400); }
  if (!isPlainObject(body)) return jsonError('Body must be a JSON object', 400);

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return jsonError('text は必須です', 400);
  if (text.length > MAX_TEXT) return jsonError(`text は${MAX_TEXT}文字以内にしてください`, 400);
  if (typeof body.voice !== 'string' || !TTS_VOICES.has(body.voice)) return jsonError('voice is not allowed', 400);
  const model = body.model == null ? DEFAULT_TTS_MODEL : body.model;
  if (typeof model !== 'string' || !TTS_MODELS.has(model)) return jsonError('model is not allowed', 400);
  let style = null;
  if (body.style != null) {
    if (typeof body.style !== 'string' || body.style.length > MAX_STYLE) return jsonError(`style は${MAX_STYLE}文字以内の文字列です`, 400);
    style = body.style.trim() || null;
  }

  // text は読み上げる文そのもの（指示は入れない）。話し方は speech_metadata.style で渡す（公式）
  const part = { type: 'text', text };
  if (style) part.annotations = [{ type: 'speech_metadata', style }];
  const payload = {
    model,
    input: [{ type: 'user_input', content: [part] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: body.voice }] },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TTS_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return jsonError(e && e.name === 'AbortError' ? 'Gemini TTS upstream timeout' : 'Gemini TTS upstream unreachable', 504);
  }
  try {
    if (!res.ok) return upstreamError(res.status);
    let j;
    try { j = await res.json(); } catch { return jsonError('Gemini TTS upstream returned invalid JSON', 502); }
    const b64 = lastAudioData(j);
    if (!b64) return jsonError('Gemini TTS upstream returned no audio', 502);
    if (b64.length > MAX_AUDIO_BYTES * 1.4) return jsonError('Gemini TTS audio too large', 502);
    let bytes;
    try { bytes = b64ToBytes(b64); } catch { return jsonError('Gemini TTS upstream returned invalid audio', 502); }
    if (bytes.length > MAX_AUDIO_BYTES) return jsonError('Gemini TTS audio too large', 502);
    return new Response(isRiff(bytes) ? bytes : wrapPcmAsWav(bytes), {
      status: 200, headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' },
    });
  } finally { clearTimeout(timer); }
}
