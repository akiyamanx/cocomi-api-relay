# cocomi-api-relay

**COCOMI API中継Worker — 三姉妹APIキーを安全に管理するCloudflare Worker**

COCOMITalk（GitHub Pages）からのAPIリクエストを中継し、APIキーをフロントエンドから完全に隠す。

## エンドポイント

| パス | 転送先 | 用途 |
|------|--------|------|
| `POST /gemini` | Google Gemini API | ここちゃん（三女） |
| `POST /openai` | OpenAI Chat API | お姉ちゃん（長女） |
| `POST /claude` | Anthropic Messages API | クロちゃん（次女） |
| `POST /whisper` | OpenAI Whisper API | 音声認識 |
| `GET /health` | - | ヘルスチェック |

## セキュリティ

- APIキーはCloudflare Worker Secrets（環境変数）で管理
- CORS: `https://akiyamanx.github.io` のみ許可
- `X-COCOMI-AUTH` ヘッダーによる認証トークン検証
- リトライ: 最大3回・指数バックオフ（安全ガイド準拠）

## セットアップ

```bash
# 1. 依存インストール
npm install

# 2. Secretsを設定（各APIキーを登録）
wrangler secret put GEMINI_API_KEY
wrangler secret put OPENAI_API_KEY
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put COCOMI_AUTH_TOKEN

# 3. ローカルテスト
wrangler dev

# 4. デプロイ
wrangler deploy
```

## テスト方法

```bash
# ヘルスチェック（認証不要）
curl https://cocomi-api-relay.akiyamanx.workers.dev/health

# Gemini APIテスト
curl -X POST https://cocomi-api-relay.akiyamanx.workers.dev/gemini \
  -H "Content-Type: application/json" \
  -H "X-COCOMI-AUTH: your-token" \
  -d '{"model":"gemini-2.0-flash","contents":[{"parts":[{"text":"こんにちは"}]}]}'
```

## 代替デプロイ（GitHub Actions）

Termuxで `wrangler deploy` が動かない場合:

```yaml
# .github/workflows/deploy-worker.yml
name: Deploy Worker
on:
  push:
    branches: [main]
    paths: ['**']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
```

---

作成: クロちゃん🔮 / 2026-03-07 / cocomi-api-relay v1.0
