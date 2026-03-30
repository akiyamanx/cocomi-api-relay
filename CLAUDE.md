# COCOMI Agent Hub Phase 1

<!-- クロちゃんチェック: ドキュメントバージョンを冒頭に明記 -->
<!-- Document Version: v1.7.0 -->

## プロジェクト概要
既存の `cocomi-api-relay` リポジトリをモノレポ化し、既存の relay Worker とは別に、新規の agent Worker を追加するプロジェクト。  
目的は、自律エージェントの統制基盤として、タスク管理、承認フロー、コスト制御、監査ログ、緊急停止、通知基盤を段階的に実装すること。

## プロジェクト名
- リポジトリ: `cocomi-api-relay`
- 新規Worker名: `agent-hub`
- 配置: `workers/agent-hub/`

## 基本方針
- 構成は **モノレポ内・別Worker**
- D1は **既存DBを共有**
- 既存 relay Worker の責務は維持し、agent-hub 側で統制機能を実装する
- Phase 1は段階実装とし、安全機構を優先する

## プロジェクトルール
- **1ファイル500行以内**（超過する場合は機能単位で分割すること）
- **日本語コメント必須**（関数・ブロック・分岐の意図を日本語で記述する）
- **バージョン番号付与**（各実装ファイル冒頭に `// Version: x.y.z` 形式で記載する）
- 既存 relay Worker に不要な責務を混ぜない
- agent-hub 側の DB 書き込みは、**agent用テーブルのみ**
- 既存 `memories` 等の保護対象テーブルは、agent-hub から **書き込み禁止**
- DBアクセスは自由SQLを避け、**定義済みクエリ/ラッパー経由を優先**
- shared 配下は最小限に保つ
- 破壊的変更前に migration を用意する
- 認証トークンや秘密情報をログ出力しない
- エラー文言はユーザー向け表示と内部ログを分ける

## バージョニング
- ドキュメント版: `v1.7.0`
- 実装ファイル冒頭コメント例: `// Version: 1.0.0 — agent-hub/index.js`
- migration は連番管理すること（`0001_`, `0002_`, ...）
- バージョン更新タイミング: 各Stepの完了時にそのStepで変更したファイルのパッチバージョンを上げる

## 技術スタック
- Cloudflare Workers
- Cloudflare D1
- Cloudflare KV（ロールバック用に残存）
- JavaScript（ES Modules形式）
- Wrangler（v3系）
- Git / GitHub
- GitHub Pages
- LINE連携

## 想定ファイル構成
```txt
cocomi-api-relay/
├── workers/
│   ├── relay/
│   │   ├── index.js          # v3.1 メインルーティング
│   │   ├── memory.js         # v1.20 記憶CRUD
│   │   ├── summarizer.js     # v1.2 AI要約
│   │   ├── import.js         # v1.5 記憶インポート
│   │   ├── vector.js         # Vectorize RAG
│   │   ├── search.js         # リアルタイム検索
│   │   ├── consultation.js   # v1.0 相談トピック連携
│   │   ├── utils.js          # 共通ユーティリティ
│   │   └── wrangler.toml
│   └── agent-hub/
│       ├── index.js          # エントリポイント・ルーティング
│       ├── task.js            # タスクCRUD
│       ├── executor.js        # タスク実行制御
│       ├── cost.js            # コスト集計・制限
│       ├── permission.js      # 権限判定
│       ├── audit.js           # 監査ログ記録
│       ├── scheduler.js       # Cron/stale回収
│       ├── utils.js           # 通知・ヘルパー
│       └── wrangler.toml
├── shared/
│   ├── constants.js           # 定数・テーブル一覧
│   └── d1-helpers.js          # DB操作ラッパー・SQL検査
├── migrations/
│   └── agent/                 # agent-hub用マイグレーション
├── .github/
│   └── workflows/
│       └── deploy-worker.yml  # v3.0 自動デプロイ（relay + agent-hub + CI + LINE通知）
└── package.json
```

## D1利用ルール
- relay Worker と agent-hub Worker は同一D1を共有する
- agent-hub が所有するテーブル:
  - `agent_tasks`
  - `agent_task_steps`
  - `agent_cost_log`
  - `agent_permissions`
  - `agent_audit_log`
  - `agent_config`
- 保護対象テーブル:
  - `memories`
  - `memory_metadata`
  - `consultation_topics`
- agent-hub は保護対象テーブルへ **SELECT専用**
- INSERT / UPDATE / DELETE / DROP / ALTER を保護対象へ実行しない
- **d1-helpers.js 内の `safeExecute()` 関数を経由しないDB書き込みは禁止**

## Worker間通信ルール
- **Service Binding採用済み**（relay→agent-hub）
- wrangler.tomlのservicesバインディングで設定
- 認証ヘッダ名: `X-COCOMI-AUTH`

## 通知ルール
- コスト80%到達
- コスト上限到達
- 要承認タスク作成
- task failed
- emergency stop
以上は通知対象とする方針。  
通知先: LINE（LINE_NOTIFY_TOKEN）  
**通知処理の失敗は主処理をブロックしない（try-catchで握りつぶし、audit logに記録する）**

## 開発環境
- 端末: Galaxy（スマホ＋タブレット）
- シェル環境: Termux
- 実装支援: Claude Code（タブレット）+ claude.ai（設計・アーキテクチャ）
- 公開/管理: GitHub Pages
- デプロイ: GitHub Actions（deploy-worker.yml v3.0）— masterブランチpushで自動デプロイ

## Claude Code向け作業姿勢
- 各ステップで変更範囲を明確にする
- 既存 relay の安定稼働を優先する
- migration、設定、実装、確認を分けて進める
- 不明点は推測せず `[要確認]` を残す
- 1セッションで完了できる粒度で進める
- **各ステップ開始時に「このステップで作成/変更するファイル一覧」を最初に列挙してから作業に入る**
- **各ステップ完了時に「完了条件チェックリスト」を自己確認してから完了報告する**

## Termux環境の制約事項
- Wranglerはarm64非対応のため、Termuxで直接`wrangler deploy`が動かない
- **デプロイはGitHub Actions経由で自動実行される**（masterブランチにpushするだけでOK）
- `.github/workflows/`へのファイルpushはMCP経由では403エラー（Termuxから手動push必要）
- D1マイグレーションもダッシュボードのD1 Consoleから手動実行可能
- curlでのAPI確認時は `-H "Origin: https://akiyamanx.github.io"` を付与（CORS対応）

## ネット検索の活用ルール（v1.6追加）
Claude Codeは組み込みのWebSearch/WebFetchツールでネット検索が可能。
作業中に不明点があれば**自分で調べて解決する**こと。推測で進めるのは禁止。

### いつ検索すべきか
- APIのエラーコードやエラーメッセージの意味がわからない時
- Cloudflare Workers / D1 / Vectorize の仕様・制限を確認したい時
- npm パッケージの使い方やバージョン互換性を調べたい時
- 新しいAPI機能やベストプラクティスを確認したい時
- 既知のバグや回避策がないか調べたい時
- wrangler CLIのコマンドやオプションを確認したい時

### 検索のコツ
- 検索クエリは英語で短く具体的に（例: `Cloudflare D1 datetime function`）
- エラーメッセージはそのまま検索ワードに含める
- 公式ドキュメント（developers.cloudflare.com, docs.anthropic.com等）を優先する
- WebFetchで公式ドキュメントの特定ページを直接取得するのも有効

### 検索してはいけないケース
- COCOMI固有の内部仕様（DB名、テーブル構造等）→ このCLAUDE.mdや既存コードを参照
- APIキーやシークレット情報を含む検索

## MCP web_search活用ルール（v1.7追加）
cocomi-mcp-serverに`web_search`ツールが搭載されている（v1.4.0）。
MCP経由の検索は**承認ダイアログなし**で実行できるため、組み込みWebSearchより効率的。

### MCP web_searchを優先すべき場面
- 連続して複数の検索が必要な時（承認なしで連続実行できる）
- Cloudflare Workers / D1 / Vectorize の公式ドキュメント確認
- npmパッケージの使い方やバージョン互換性の調査
- エラーメッセージの解決策検索

### 使い方
```
ツール名: web_search
パラメータ:
  query: 検索クエリ（英語推奨、短く具体的に）
  count: 結果数（1-10、デフォルト5）
  language: 検索言語（jp/en、デフォルトen）
  freshness: 鮮度フィルタ（pd=24時間, pw=1週間, pm=1ヶ月）
```

### 使い分け
| 場面 | 推奨ツール | 理由 |
|------|----------|------|
| 連続検索・調査作業 | MCP web_search | 承認不要で効率的 |
| 特定URLのページ取得 | 組み込みWebFetch | URLを直接指定できる |
| 初回の軽い検索 | どちらでもOK | 差は小さい |

### 注意
- MCP web_searchはBrave Search API経由（月1,000クエリ無料枠）
- 不要な検索を連打しない（無料枠を無駄にしない）
- 検索結果はスニペット（要約）のみ。全文が必要ならWebFetchで該当URLを取得

## セキュリティ注意事項
- 環境変数（APIキー・認証トークン等）はCloudflare Secrets/環境変数に設定し、コードにハードコードしない
- 認証トークンは最低32文字のランダム文字列を使用
- エラーレスポンスに内部実装詳細を含めない
- CORS設定は必要最小限のオリジンに限定
