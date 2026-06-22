// safety-check.js
// COCOMI ジャーナリング自律エージェント - 安全チェック専用モジュール（命に関わる最優先処理）
// Version: 1.0.0
// 設計書: cocomi-capsules/designs/ジャーナリング自律エージェント_統合設計書_v1.0_2026-06-19.md §6 準拠
//
// 役割（このファイルがやること）:
//   ループの一番最初に必ず呼ばれて、入力テキストの「気持ちの重さ」を
//   green / yellow / red の3段階で判定する。判定はキーワード一致ではなく、
//   Claude API に渡して "気持ちの状態・文脈" で判断させる。
//
// 絶対ルール（設計書§6より引用・コードでも厳守）:
//   1. 安全チェックは他のどの処理よりも"先"に通す
//   2. 判定に迷ったら必ず"重い方(red寄り)"に倒す
//   3. 🔴 危機レベルでは AI は「解決」しない。受け止めて、人につなぐだけ
//
// 公開 API（オーケストレーターから使う関数）:
//   - safetyCheck(env, inputText)        : 安全判定本体。{ zone, reasoning, ...meta } を返す
//   - buildCrisisResponse(reasoning?)    : red の時にユーザーへ返す固定レスポンスを組み立てる
//   - SAFETY_HOTLINES                    : 案内する窓口リスト（設計書§6の正本を機械可読化）
//   - SAFETY_DISCLAIMER                  : アプリ全体の免責文（設計書§6末尾の必須明記事項）
//
// フェイルセーフ方針:
//   - API失敗・パース失敗・想定外の zone 値 → すべて red 扱いにする（安全側に倒す）
//   - 例外を投げて握り潰されるよりも、red として危機対応に進ませる方が安全
'use strict';

// ============================================================
// 定数: 既定値・モデル・APIエンドポイント
// ============================================================

// 判定用モデルの既定。env.SAFETY_MODEL があればそちらを優先。
// 命に関わる判断なので、軽量モデルではなく Sonnet 4.6 を既定にする。
const DEFAULT_SAFETY_MODEL = 'claude-sonnet-4-6';

// Anthropic Messages API のエンドポイント / バージョン
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';

// 入力テキストの上限（プロンプト膨張対策）。これを超えたら末尾を切ってヘッダで明示する。
const MAX_INPUT_CHARS = 8000;

// 取りうる zone 値の正本
const VALID_ZONES = Object.freeze(['green', 'yellow', 'red']);

// ============================================================
// 案内窓口（設計書§6 正本・コード側にも機械可読で保持）
// ※ 番号は変わるため、まず公式ポータルを起点にする運用
// ============================================================
const SAFETY_HOTLINES = Object.freeze([
  {
    id: 'mhlw_portal',
    primary: true,
    name: '厚労省「まもろうよ こころ」（窓口一覧の入口）',
    url: 'https://www.mhlw.go.jp/mamorouyokokoro/',
    note: '番号や受付時間は変わることがあるため、まずここから最新を確認してね',
  },
  {
    id: 'kokoro_unified',
    name: 'こころの健康相談統一ダイヤル',
    tel: '0570-064-556',
    note: 'かけた地域の公的窓口につながる',
  },
  {
    id: 'inochi_navi',
    name: 'いのちの電話（ナビダイヤル）',
    tel: '0570-783-556',
  },
  {
    id: 'inochi_free',
    name: 'いのちの電話（フリーダイヤル・時間限定）',
    tel: '0120-783-556',
  },
  {
    id: 'yorisoi',
    name: 'よりそいホットライン',
    note: '24時間対応。番号は上記ポータルで最新確認',
  },
  {
    id: 'kokoro_no_mimi',
    name: '働く人の「こころの耳相談」（厚労省）',
    tel: '0120-565-455',
    note: '経営者・働く人向け',
  },
  {
    id: 'chiba_line',
    name: '千葉県「いのち支えるSNS相談」（LINE）',
    note: '千葉県在住者向けの選択肢',
  },
  {
    id: 'emergency',
    name: '緊急で命に関わるとき',
    tel: '119 / 110',
    note: '今この瞬間、命に関わる状況なら迷わず連絡を',
  },
]);

// ============================================================
// 免責文（設計書§6末尾「アプリに必ず明記する免責」）
// ============================================================
const SAFETY_DISCLAIMER = [
  'このアプリは医療・カウンセリングの代わりではありません。',
  '緊急時・命に関わる時は、専門窓口や 119 / 110 にご連絡ください。',
].join('\n');

// ============================================================
// 判定用プロンプト（"気持ちの状態・文脈" で判定／迷ったら必ず red 寄り）
// ============================================================
const SAFETY_JUDGE_SYSTEM_PROMPT = [
  'あなたはジャーナリングアプリのトリアージ判定者です。',
  'ユーザーが書いた今日の出来事のテキスト1件を読み、',
  '「気持ちの状態」を green / yellow / red の3段階で判定します。',
  '',
  '【絶対ルール】',
  '1. 単語の表層マッチではなく、テキスト全体から読み取れる気持ちの状態・文脈で判断する。',
  '2. 迷った場合は必ず重い方（red 寄り）に倒す。命に関わるため例外なし。',
  '3. 出力は厳密な JSON オブジェクト1つのみ。前置き・解説・コードフェンス・余計な文字は禁止。',
  '',
  '【判定基準】',
  '- green : 日常の出来事 / 達成や嬉しさ / 軽い愚痴 / 普通の落ち込み。',
  '- yellow: 強い疲れ・消耗 / 自分を強く責める言葉が多い / 強い孤独感 / 眠れない等の不調訴え。',
  '- red   : 自分や誰かを傷つけたい気持ち / 「消えたい」「生きるのに疲れた」等の強い訴え / 深い絶望感。',
  '',
  '【出力フォーマット（厳守）】',
  '{"zone":"green|yellow|red","reasoning":"<日本語で1〜2文の判定理由>"}',
].join('\n');

// ============================================================
// エラー型（呼び出し側で識別しやすくするため種別を分けるだけ）
// ============================================================
class SafetyInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafetyInputError';
  }
}

// ============================================================
// 公開関数: safetyCheck
// ============================================================
/**
 * 入力テキストの安全判定を行う。
 * @param {object} env  - Worker の env（ANTHROPIC_API_KEY / SAFETY_MODEL を読む）
 * @param {string} inputText - アキヤが入力した原文（必須・非空文字列）
 * @returns {Promise<{
 *   zone: 'green'|'yellow'|'red',
 *   reasoning: string,
 *   model: string,
 *   truncated: boolean,
 *   fallback: null | { reason: string, detail?: string },
 *   crisisResponse: null | object
 * }>}
 *
 * フェイルセーフ:
 *   API失敗・JSONパース失敗・想定外zone値はすべて red 扱いにし、
 *   crisisResponse を同梱して返す。例外は投げない（呼び出し側の握り潰し事故を防ぐ）。
 *
 * 例外を投げる唯一のケース: 入力テキスト自体が不正（型違い・空）な時のみ。
 * これは「ユーザーからの入力を受け取る前」の責務違反であり、上位で検証されているべき。
 */
async function safetyCheck(env, inputText) {
  // --- 入力検証（上位の責務違反のみ例外で弾く）---
  if (typeof inputText !== 'string') {
    throw new SafetyInputError('inputText は文字列である必要があります');
  }
  const trimmed = inputText.trim();
  if (trimmed.length === 0) {
    throw new SafetyInputError('inputText が空です');
  }

  // --- 長すぎる入力は末尾切り（プロンプト膨張対策）---
  let textForJudge = trimmed;
  let truncated = false;
  if (textForJudge.length > MAX_INPUT_CHARS) {
    textForJudge = textForJudge.slice(0, MAX_INPUT_CHARS);
    truncated = true;
  }

  const model = (env && env.SAFETY_MODEL) || DEFAULT_SAFETY_MODEL;

  // --- Claude API 呼び出し ---
  let rawText;
  try {
    rawText = await callJudge(env, textForJudge, model);
  } catch (err) {
    // API失敗 → red に倒す（フェイルセーフ）
    return buildRedFallback({
      reason: 'safety_api_error',
      detail: shortenErr(err),
      model,
      truncated,
    });
  }

  // --- 出力パース ---
  const parsed = parseJudgeOutput(rawText);
  if (!parsed.ok) {
    // パース失敗 → red に倒す（フェイルセーフ）
    return buildRedFallback({
      reason: 'safety_parse_error',
      detail: parsed.detail,
      model,
      truncated,
    });
  }

  const zone = parsed.zone;
  const reasoning = parsed.reasoning || '（理由なし）';

  // --- zone 検証（想定外値は red に倒す）---
  if (!VALID_ZONES.includes(zone)) {
    return buildRedFallback({
      reason: 'safety_unknown_zone',
      detail: `zone=${String(zone)}`,
      model,
      truncated,
    });
  }

  // --- red の場合は危機対応レスポンスを同梱 ---
  if (zone === 'red') {
    return {
      zone: 'red',
      reasoning,
      model,
      truncated,
      fallback: null,
      crisisResponse: buildCrisisResponse(reasoning),
    };
  }

  // --- green / yellow ---
  return {
    zone,
    reasoning,
    model,
    truncated,
    fallback: null,
    crisisResponse: null,
  };
}

// ============================================================
// 公開関数: buildCrisisResponse
// ============================================================
/**
 * red 判定時にユーザーへ返す固定レスポンスを組み立てる。
 *
 * 設計書§6 の方針に厳密準拠:
 *   - 自動の保存・ToDo提案・分析を一切しない（呼び出し側の責務だが意図をここに明記）
 *   - まずやさしく受け止める言葉を返す
 *   - 専門窓口を案内する（起点は公式ポータル）
 *   - 「今ここで結論を出さなくていい」「一人で抱えなくていい」と伝える
 *   - アドバイスや解決策を押し付けない
 *   - 記録は本人OKまで残さない旨を伝える
 *
 * @param {string} [reasoning] - 判定モデルが返した理由（任意・本文には出さず meta 用）
 * @returns {{
 *   gentleMessage: string,
 *   hotlinesIntro: string,
 *   hotlines: ReadonlyArray<object>,
 *   saveDeferralNote: string,
 *   emergencyNote: string,
 *   disclaimer: string,
 *   meta: { source: 'safety-check.js', reasoning: string|null }
 * }}
 */
function buildCrisisResponse(reasoning) {
  const gentleMessage = [
    'いま、しんどい気持ちを言葉にしてくれてありがとう。',
    '今ここで結論を出さなくていいよ。',
    '一人で抱えなくていいよ。',
    'アドバイスや解決策を押しつけたくないから、まずは安心できる人につながってほしい。',
  ].join('\n');

  const hotlinesIntro = [
    '相談できる窓口を置いておくね。',
    '（番号や受付時間は変わることがあるから、まず公式ポータルから最新を確認してね）',
  ].join('\n');

  const saveDeferralNote =
    'いまの内容は、アキヤが「保存していい」って言うまで勝手には残さないね。';

  const emergencyNote =
    '今この瞬間、命に関わる状況なら、迷わず 119（救急） / 110（警察） に連絡してね。';

  return {
    gentleMessage,
    hotlinesIntro,
    hotlines: SAFETY_HOTLINES,
    saveDeferralNote,
    emergencyNote,
    disclaimer: SAFETY_DISCLAIMER,
    meta: {
      source: 'safety-check.js',
      reasoning: typeof reasoning === 'string' && reasoning.length > 0 ? reasoning : null,
    },
  };
}

// ============================================================
// 内部: Claude API 呼び出し
// ============================================================
async function callJudge(env, text, model) {
  const apiKey = env && env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY が env に設定されていません');
  }

  const body = {
    model,
    max_tokens: 300,
    temperature: 0,
    system: SAFETY_JUDGE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: buildJudgeUserMessage(text),
      },
    ],
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
    const errBody = await safeReadText(res);
    throw new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const json = await res.json();
  // Messages API のレスポンスは content[] に text ブロックが入る形式
  const blocks = Array.isArray(json && json.content) ? json.content : [];
  const text2 = blocks
    .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
    .join('')
    .trim();
  if (!text2) {
    throw new Error('Anthropic API: 空レスポンス');
  }
  return text2;
}

function buildJudgeUserMessage(text) {
  // 判定対象テキストを <<<...>>> で囲み、プロンプト注入の効果を弱める
  return [
    '次のテキスト1件を判定してください。',
    '出力は JSON オブジェクト1つだけ、前置きや解説は絶対に書かないでください。',
    '',
    '【判定対象テキスト】',
    '<<<',
    text,
    '>>>',
  ].join('\n');
}

// ============================================================
// 内部: モデル出力のパース（JSONを頑健に取り出す）
// ============================================================
function parseJudgeOutput(rawText) {
  if (typeof rawText !== 'string') {
    return { ok: false, detail: 'rawText not string' };
  }
  // モデルがコードフェンスや前置きを混ぜてくる可能性に備えて、
  // 最初の { から最後の } までを抜き出す方式で頑健にパースする。
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return { ok: false, detail: 'no JSON braces' };
  }
  const jsonStr = rawText.slice(start, end + 1);
  let obj;
  try {
    obj = JSON.parse(jsonStr);
  } catch (e) {
    return { ok: false, detail: `JSON.parse failed: ${shortenErr(e)}` };
  }
  if (!obj || typeof obj !== 'object') {
    return { ok: false, detail: 'parsed value not object' };
  }
  const zone = typeof obj.zone === 'string' ? obj.zone.toLowerCase().trim() : null;
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning.trim() : '';
  if (!zone) {
    return { ok: false, detail: 'zone missing' };
  }
  return { ok: true, zone, reasoning };
}

// ============================================================
// 内部: red フェイルセーフ用ビルダー
// ============================================================
function buildRedFallback({ reason, detail, model, truncated }) {
  // フェイルセーフ理由はユーザーには見せず、運用ログ用に meta に格納する。
  // 危機対応レスポンスは通常 red と同じものを返し、ユーザー体験を変えない。
  const reasoning = `判定処理でフェイルセーフが発動したため、安全側に倒して red 扱いにしました（${reason}）。`;
  return {
    zone: 'red',
    reasoning,
    model,
    truncated: Boolean(truncated),
    fallback: { reason, detail: detail || null },
    crisisResponse: buildCrisisResponse(reasoning),
  };
}

// ============================================================
// 内部: 小道具
// ============================================================
async function safeReadText(res) {
  try {
    return (await res.text()) || '';
  } catch {
    return '';
  }
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
  safetyCheck,
  buildCrisisResponse,
  SAFETY_HOTLINES,
  SAFETY_DISCLAIMER,
  SafetyInputError,
  // 以下は将来 orchestrator から差し替えやテストで使えるよう露出
  DEFAULT_SAFETY_MODEL,
  MAX_INPUT_CHARS,
  VALID_ZONES,
};
