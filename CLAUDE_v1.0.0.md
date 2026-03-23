# COCOMI Agent Hub Phase 1

<!-- クロちゃんチェック: ドキュメントバージョンを冒頭に明記 -->
<!-- Document Version: v1.0.0 -->

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
<!-- クロちゃんチェック: コメント・バージョンルールの具体的な書式を追記 -->

## バージョニング
- ドキュメント版: `v1.0.0`
- 実装ファイル冒頭コメント例: `// Version: 1.0.0 — agent-hub/index.js`
- migration は連番管理すること（`0001_`, `0002_`, ...）
- バージョン更新タイミング: 各Stepの完了時にそのStepで変更したファイルのパッチバージョンを上げる
<!-- クロちゃんチェック: バージョン記載の具体例とタイミングを追記 -->

## 技術スタック
- Cloudflare Workers
- Cloudflare D1
- [要確認] Cloudflare KV
- JavaScript（ES Modules形式）
- Wrangler（v3系を想定）
- Git / GitHub
- GitHub Pages
- LINE連携
- [要確認] Discord / Slack 等のWebhook通知
<!-- クロちゃんチェック: JS形式とWranglerバージョンを明記 -->

## 想定ファイル構成
```txt
cocomi-api-relay/
├── workers/
│   ├── relay/
│   │   ├── index.js
│   │   ├── memory.js
│   │   ├── import.js
│   │   ├── vector.js
│   │   ├── search.js
│   │   ├── utils.js
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
│   ├── auth.js               # 認証チェック共通
│   ├── constants.js           # 定数・テーブル一覧
│   └── d1-helpers.js          # DB操作ラッパー・SQL検査
├── migrations/
│   ├── 0001_initial.sql       # 既存relay用（既存）
│   └── 0002_agent_hub.sql     # agent-hub用テーブル
├── wrangler.toml              # relay用（既存）
├── wrangler.agent.toml        # agent-hub用
└── package.json
```
<!-- クロちゃんチェック: 各ファイルの役割コメントを追記 -->

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
  - [要確認] relay側の他テーブル一覧
- agent-hub は保護対象テーブルへ **SELECT専用**
- INSERT / UPDATE / DELETE / DROP / ALTER を保護対象へ実行しない
- **d1-helpers.js 内の `safeExecute()` 関数を経由しないDB書き込みは禁止**
<!-- クロちゃんチェック: 具体的な関数名でガード方法を明記 -->

## Worker間通信ルール
- Phase 1前半は **HTTP fetch + 共有認証トークン** を暫定採用
- Sprint 3終了時（Step 10完了時）に Service Binding を再評価する
- relay → agent-hub の中継ルートを設ける（relay側に `/agent/*` プロキシを追加）
- 認証ヘッダ名は [要確認]（暫定: `X-Agent-Auth-Token`）
<!-- クロちゃんチェック: 暫定ヘッダ名を提案として追記 -->

## 通知ルール
- コスト80%到達
- コスト上限到達
- 要承認タスク作成
- task failed
- emergency stop
以上は通知対象とする方針。  
通知先は [要確認]。  
**通知処理の失敗は主処理をブロックしない（try-catchで握りつぶし、audit logに記録する）**
<!-- クロちゃんチェック: 通知失敗時の挙動を明記 -->

## 開発環境
- 端末: Galaxy
- シェル環境: Termux
- 実装支援: Claude Code
- 公開/管理: GitHub Pages
- デプロイ: Wrangler

## Claude Code向け作業姿勢
- 各ステップで変更範囲を明確にする
- 既存 relay の安定稼働を優先する
- migration、設定、実装、確認を分けて進める
- 不明点は推測せず `[要確認]` を残す
- 1セッションで完了できる粒度で進める
- **各ステップ開始時に「このステップで作成/変更するファイル一覧」を最初に列挙してから作業に入る**
- **各ステップ完了時に「完了条件チェックリスト」を自己確認してから完了報告する**
<!-- クロちゃんチェック: Claude Codeの作業開始・終了時の手順を追記 -->
## Termux環境の制約事項
- Wranglerはarm64非対応のため、Termuxで直接`wrangler deploy`が動かない場合がある
- 代替策1: Cloudflareダッシュボードから手動デプロイ
- 代替策2: GitHub Actions経由でCI/CDデプロイ（安全ガイド参照）
- D1マイグレーションもダッシュボードのD1 Consoleから手動実行可能
- curlでのAPI確認時は `-H "Origin: https://akiyamanx.github.io"` を付与（CORS対応）
<!-- クロちゃんチェック: Termux制約を追記（議事録で議論されなかった実運用上の制約） -->

## セキュリティ注意事項
- 環境変数（APIキー・認証トークン等）はCloudflare Secrets/環境変数に設定し、コードにハードコードしない
- 認証トークンは最低32文字のランダム文字列を使用
- エラーレスポンスに内部実装詳細を含めない
- CORS設定は必要最小限のオリジンに限定
