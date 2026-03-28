// このファイルは何をするか:
// Gemini FlashによるAI要約機能を提供する。
// memory.jsから分離。チャット・会議の要約プロンプト、JSON抽出、文末処理を担当。
// v1.0 2026-03-28 - memory.js v1.19から分離新設（500行制限対応）
// v1.1 2026-03-28 - SUMMARY_SCHEMA description追加（Gemini出力品質向上）＋cleanSummaryEnding「な」誤判定修正
// v1.2 2026-03-28 - finish_reason検証追加＋emotionデフォルト値＋maxOutputTokens増量＋結果バリデーション強化

// ============================================================
// Gemini API設定
// ============================================================
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// v1.1改善 - Gemini JSON出力スキーマ（descriptionで出力品質を制御）
const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: {
      type: 'STRING',
      description: '50〜200文字の日本語要約。固有名詞・数値・決定事項を省略せず含む。必ず「。」で文を終わらせること。抽象的な表現は禁止',
    },
    decisions: { type: 'ARRAY', items: { type: 'STRING' } },
    category: { type: 'STRING' },
    topic: {
      type: 'STRING',
      description: '会話の主題を10〜30文字で要約。具体的な名詞を含めること',
    },
    emotion_user: {
      type: 'INTEGER',
      description: 'ユーザーの感情温度1〜5。1=落ち込み 2=元気ない 3=普通 4=楽しい 5=最高',
    },
    emotion_ai: {
      type: 'INTEGER',
      description: 'AI側の感情温度1〜5。1=心配 2=控えめ 3=穏やか 4=楽しい 5=大喜び',
    },
    emotion_comment: {
      type: 'STRING',
      description: '会話全体の雰囲気を30〜60文字で一言コメント。プレーンテキストのみ',
    },
  },
  required: ['summary', 'topic', 'emotion_user', 'emotion_ai', 'emotion_comment'],
};

// ============================================================
// AI要約メイン関数
// ============================================================
export async function summarizeWithAI(topic, rawHistory, env, type = 'meeting') {
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
      generationConfig: {
        // v1.2変更 - 1024→2048に増量（途中切れ防止）
        maxOutputTokens: 2048,
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: SUMMARY_SCHEMA,
      },
    }),
  });

  if (!res.ok) throw new Error(`Gemini API ${res.status}`);
  const data = await res.json();

  // v1.2追加 - finish_reason検証
  const candidate = data?.candidates?.[0];
  const finishReason = candidate?.finishReason || 'UNKNOWN';
  if (finishReason !== 'STOP') {
    console.warn(`[summarizer] finish_reason: ${finishReason}（STOP以外 — 出力が途中切れの可能性）`);
  }

  const text = candidate?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('AI応答が空');

  const result = extractJSON(text);

  // v1.2追加 - 結果バリデーション＋デフォルト値補完
  return _validateAndFillDefaults(result, finishReason);
}

// ============================================================
// v1.2追加 - 結果バリデーション＋デフォルト値補完
// Geminiがemotionフィールドを返さない場合にデフォルト値を入れる
// summaryが「。」で終わっていない場合にcleanSummaryEndingを適用
// ============================================================
function _validateAndFillDefaults(result, finishReason) {
  // emotion_user: 未設定/範囲外 → デフォルト3（普通）
  const eu = Number(result.emotion_user);
  if (isNaN(eu) || eu < 1 || eu > 5) {
    result.emotion_user = 3;
    console.warn('[summarizer] emotion_user欠落 → デフォルト3を設定');
  }

  // emotion_ai: 未設定/範囲外 → デフォルト3（穏やか）
  const ea = Number(result.emotion_ai);
  if (isNaN(ea) || ea < 1 || ea > 5) {
    result.emotion_ai = 3;
    console.warn('[summarizer] emotion_ai欠落 → デフォルト3を設定');
  }

  // emotion_comment: 未設定 → デフォルトコメント
  if (!result.emotion_comment || typeof result.emotion_comment !== 'string' || result.emotion_comment.length < 3) {
    result.emotion_comment = '会話の記録';
    console.warn('[summarizer] emotion_comment欠落 → デフォルト設定');
  }

  // summary: 「。」で終わっていなければcleanSummaryEndingを適用
  if (result.summary && typeof result.summary === 'string') {
    if (!result.summary.endsWith('。') && !result.summary.endsWith('！') && !result.summary.endsWith('？')) {
      const cleaned = cleanSummaryEnding(result.summary);
      if (cleaned !== result.summary) {
        console.log(`[summarizer] summary文末修正: "${result.summary.slice(-10)}" → "${cleaned.slice(-10)}"`);
      }
      // cleanSummaryEndingでも「。」にならなかった場合、「。」を付加
      if (!cleaned.endsWith('。') && !cleaned.endsWith('！') && !cleaned.endsWith('？')) {
        result.summary = cleaned + '。';
        console.log('[summarizer] summary末尾に「。」を付加');
      } else {
        result.summary = cleaned;
      }
    }
  }

  // topic: 未設定 → フォールバック
  if (!result.topic || typeof result.topic !== 'string' || result.topic.length < 2) {
    result.topic = '会話の記録';
    console.warn('[summarizer] topic欠落 → デフォルト設定');
  }

  // finish_reasonが異常だった場合の情報付与
  if (finishReason !== 'STOP' && finishReason !== 'UNKNOWN') {
    result._finishReason = finishReason;
  }

  return result;
}

// ============================================================
// チャット要約用プロンプト（v1.18で具体情報保持ルール追加）
// ============================================================
function _buildChatPrompt(historyText) {
  return `以下の1対1チャット会話を要約してJSON形式で出力してください。
JSON以外は絶対に出力しないでください。前置き文もコードフェンスも不要です。

出力形式の例:
{"summary":"ここちゃんの好きな食べ物はふわふわのパンケーキ。お姉ちゃんはカレーとタコスとお寿司に興味。クロちゃんは蕎麦を食べてみたいと回答した。","decisions":["三姉妹の好きな食べ物が決まった"],"category":"食事","topic":"三姉妹の好きな食べ物を聞いた","emotion_user":5,"emotion_ai":5,"emotion_comment":"三姉妹それぞれの好みを楽しく聞き出した温かい会話"}

【最重要ルール: 具体情報の保持】
以下の情報は必ずsummaryに含めること。省略・抽象化は絶対にしないこと:
- 固有名詞（人名、地名、店名、サービス名、技術名、料理名）
- 具体的な数値（金額、日付、バージョン番号、件数、設定値）
- 決定事項の具体内容（「○○に決定」「○○を採用」）
- 好み・嗜好の具体名（「パンケーキが好き」「蕎麦に興味」等、具体的な名前を必ず残す）
- 理由・根拠（「なぜなら○○だから」）

❌ 絶対NG: 「好きな食べ物について話した」「技術的な方針を議論した」「設定について相談した」
✅ 必ずこう書く: 「ここちゃんの好きな食べ物はパンケーキと判明」「TTS方式はVOICEVOXに決定」「月額上限を$10に設定した」

その他のルール:
- summaryは50〜200文字の日本語。具体情報を優先し、文字数は柔軟に使うこと
- summaryは必ず「。」で文を終わらせること。途中で切れた文は禁止
- topicは会話の主題を10〜30文字で要約
- categoryは以下から1つ選択: 開発/雑談/ドライブ/食事/晩酌/仕事/趣味/相談/家族
- decisionsは決まったことがあれば配列で。雑談なら空配列[]
- emotion_userはユーザーの感情温度を1〜5の整数で（1=落ち込み 2=元気ない 3=普通 4=楽しい 5=最高）。必ず数値を返すこと
- emotion_aiはAI側の感情温度を1〜5の整数で（1=心配 2=控えめ 3=穏やか 4=楽しい 5=大喜び）。必ず数値を返すこと
- emotion_commentは会話全体の雰囲気を30〜60文字で一言コメント。必ず記入すること
- マークダウン記法は使わない。プレーンテキストのみ
- JSON以外の文字を出力しない

チャット会話:
${historyText}`;
}

// ============================================================
// 会議要約用プロンプト（v1.18で具体情報保持ルール追加）
// ============================================================
function _buildMeetingPrompt(topic, historyText) {
  return `会議記録を要約してJSON形式で出力してください。
JSON以外は絶対に出力しないでください。前置き文もコードフェンスも不要です。

出力形式の例:
{"summary":"COCOMITalkのTTS方式をVOICEVOXメイン＋OpenAI TTSフォールバックに決定。月額コストは200〜400円の見込み。voice-output.js v2.1で実装する方針。","decisions":["VOICEVOXをメインTTSとして採用","OpenAI TTSをフォールバックに設定","voice-output.js v2.1で実装開始"],"emotion_user":4,"emotion_ai":5,"emotion_comment":"活発に議論が進み全員が前向きな雰囲気だった"}

【最重要ルール: 具体情報の保持】
以下の情報は必ずsummaryとdecisionsに含めること。省略・抽象化は絶対にしないこと:
- 固有名詞（人名、地名、サービス名、技術名、ファイル名）
- 具体的な数値（金額、日付、バージョン番号、件数、設定値）
- 決定事項の具体内容（「○○に決定」「○○を採用」「○○は不採用」）
- 採用理由・却下理由
- ファイル名やバージョン（voice-output.js v2.1等）

❌ 絶対NG: 「技術的な方針について議論した」「コストについて検討した」「実装方法を決めた」
✅ 必ずこう書く: 「TTS方式はVOICEVOXに決定。理由はコスト月200〜400円と音質のバランス。」

その他のルール:
- summaryは50〜200文字の日本語。具体情報を優先し、文字数は柔軟に使うこと
- summaryは必ず「。」で文を終わらせること。途中で切れた文は禁止
- decisionsは具体的な決定事項のみ。各40文字以内の配列。決定事項がなければ空配列[]
- emotion_userはユーザーの感情温度を1〜5の整数で（1=落ち込み 2=元気ない 3=普通 4=楽しい 5=最高）。必ず数値を返すこと
- emotion_aiはAI側の感情温度を1〜5の整数で（1=心配 2=控えめ 3=穏やか 4=楽しい 5=大喜び）。必ず数値を返すこと
- emotion_commentは会議全体の雰囲気を30〜60文字で一言コメント。必ず記入すること
- マークダウン記法(#,**,|,-等)は使わない。プレーンテキストのみ
- 見出しや箇条書き記号を含めない
- JSON以外の文字を出力しない

議題: ${topic}
会議記録:
${historyText}`;
}

// ============================================================
// summary文末クリーンアップ（v1.19追加、v1.1改善）
// 旧ロジックは「について議論した」を強制付加していた。
// 新ロジックは日本語の自然な文末パターンを幅広く許可する。
// v1.1改善: 「な」を単独文末から除外（形容動詞途中切れ防止）
// ============================================================
export function cleanSummaryEnding(text) {
  // v1.1改善 - 「な」を単独文末から除外。形容動詞「〜な」の途中切れを防ぐ
  const naturalEndings = /[。！？たるすくむぶつぬういだねよわぞさかっ）」』]$/;
  const twoCharEndings = /(だな|かな|よな|のな|もな)$/;
  if (naturalEndings.test(text) || twoCharEndings.test(text)) {
    return text;
  }
  // 助詞の途中切れ → 末尾の不完全な助詞を除去
  const trimmed = text.replace(/[をがはのにやとで、へもな]+$/, '');
  if (naturalEndings.test(trimmed) || twoCharEndings.test(trimmed)) {
    return trimmed;
  }
  // 最後の自然な文末で切る
  const lastNatural = trimmed.search(/[。！？たるすくむぶつぬういだねよわぞさかっ）」』][^。！？たるすくむぶつぬういだねよわぞさかっ）」』]*$/);
  if (lastNatural !== -1) {
    const endPos = lastNatural + 1;
    if (endPos > 20) {
      return trimmed.substring(0, endPos);
    }
  }
  // どうしても見つからない → そのまま返す（情報保持優先）
  return text;
}

// ============================================================
// 堅牢なJSON抽出（6段階フォールバック）
// ============================================================
export function extractJSON(text) {
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
