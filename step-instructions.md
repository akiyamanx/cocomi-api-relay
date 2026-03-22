# COCOMI Agent Hub — Step Instructions for Claude Code

<!-- Document Version: v1.0.0 -->
<!-- 三姉妹会議(2026-03-21)の決定事項に基づくClaude Code向け作業指示書 -->
<!-- CLAUDE.mdと設計書v1.0.0を必ず先に読んでから作業すること -->

## 全体方針
- 構成: モノレポ内・別Worker（`workers/relay/` + `workers/agent-hub/`）
- D1: 既存DBを共有（`cocomi-memory`, ID: `1b164b3b-a737-4721-aa07-86d6c821c8e6`）
- 安全優先: ブレーキ（コスト管理）をアクセル（実行機能）より先に作る
- 500行ルール厳守、日本語コメント必須、バージョン番号付与

---

## Sprint 1: モノレポ移行 + agent-hub骨格 + マイグレーション

### Step 1: ディレクトリ構造の作成

**作成/変更するファイル:**
- `workers/relay/` ディレクトリ
- `workers/agent-hub/` ディレクトリ
- `shared/` ディレクトリ
- `migrations/agent/` ディレクトリ

**作業内容:**
```bash
mkdir -p workers/relay workers/agent-hub shared migrations/agent
```

**完了条件:**
- [ ] 上記4ディレクトリが存在すること

---

### Step 2: 既存ファイルのrelay/への移動

**作成/変更するファイル:**
- `workers/relay/index.js` （src/index.js から移動）
- `workers/relay/memory.js` （src/memory.js から移動）
- `workers/relay/import.js` （src/import.js から移動）
- `workers/relay/vector.js` （src/vector.js から移動）
- `workers/relay/search.js` （src/search.js から移動）
- `workers/relay/utils.js` （src/utils.js から移動）

**作業内容:**
```bash
git mv src/index.js workers/relay/
git mv src/memory.js workers/relay/
git mv src/import.js workers/relay/
git mv src/vector.js workers/relay/
git mv src/search.js workers/relay/
git mv src/utils.js workers/relay/
```

**注意:**
- `git mv`を使うことでgit履歴を保持する
- 移動後、各ファイル内のimportパスに変更が必要ないか確認する（現在は相対importのため影響なしのはず）

**完了条件:**
- [ ] `workers/relay/`に6ファイルが存在すること
- [ ] `src/`が空（または削除済み）であること
- [ ] `git status`で6ファイルがrenamedとして表示されること

---

### Step 3: workers/relay/wrangler.toml の作成

**作成するファイル:**
- `workers/relay/wrangler.toml`

**内容:**
既存のルートの`wrangler.toml`の内容をコピーし、`main`のパスを調整する。

```toml
name = "cocomi-api-relay"
main = "index.js"
compatibility_date = "2024-09-23"

[[d1_databases]]
binding = "DB"
database_name = "cocomi-memory"
database_id = "1b164b3b-a737-4721-aa07-86d6c821c8e6"

# 既存のVectorize, KV等のバインディングもそのままコピー
# （既存wrangler.tomlから全バインディングをコピーすること）
```

**注意:**
- Worker名`cocomi-api-relay`は変更しない（既存URLを維持するため）
- 既存のVectorize（`cocomi-memory-vectors`）やKVバインディングも忘れずにコピー

**完了条件:**
- [ ] `workers/relay/wrangler.toml`が存在すること
- [ ] 既存の全バインディングが含まれていること
- [ ] `name`が`cocomi-api-relay`であること

---

### Step 4: ルートのwrangler.toml処理

**変更するファイル:**
- ルートの`wrangler.toml`

**作業内容:**
ルートの`wrangler.toml`を削除する。

```bash
git rm wrangler.toml
```

**完了条件:**
- [ ] ルートに`wrangler.toml`が存在しないこと
- [ ] `workers/relay/wrangler.toml`のみが残っていること

---

### Step 5: relay Workerのデプロイ確認

**作業内容:**
```bash
cd workers/relay && wrangler deploy
```

※ Termuxでwranglerが動かない場合:
- Cloudflareダッシュボードから手動デプロイ
- または`git push`後にGitHub Actionsで自動デプロイ

**確認方法:**
```bash
curl -H "Origin: https://akiyamanx.github.io" \
     -H "X-COCOMI-AUTH: cocomi-family-2026-secret" \
     https://cocomi-api-relay.{account}.workers.dev/health
```

**完了条件:**
- [ ] 既存のchat/group/meetingモードが正常動作すること
- [ ] メモリー取得APIが正常応答すること
- [ ] Vectorize検索が正常動作すること

**失敗時の復旧:**
git revertで元のディレクトリ構造に戻し、ルートのwrangler.tomlを復元する。

---

### Step 6: wrangler.agent.toml の作成

**作成するファイル:**
- `workers/agent-hub/wrangler.toml`

**内容:**
```toml
name = "cocomi-agent-hub"
main = "index.js"
compatibility_date = "2024-09-23"

[[d1_databases]]
binding = "DB"
database_name = "cocomi-memory"
database_id = "1b164b3b-a737-4721-aa07-86d6c821c8e6"

[vars]
ENVIRONMENT = "production"
DAILY_COST_HARD_LIMIT_MICRO_USD = "1000000"
MONTHLY_COST_HARD_LIMIT_MICRO_USD = "10000000"
DAILY_COST_SOFT_LIMIT_MICRO_USD = "700000"

# Secrets（wrangler secret putまたはダッシュボードで設定）:
# AGENT_AUTH_TOKEN — agent-hub認証用
# SHARED_AUTH_TOKEN — relay↔agent間内部認証用
```

**完了条件:**
- [ ] `workers/agent-hub/wrangler.toml`が存在すること
- [ ] D1バインディングが既存DBを指していること
- [ ] コスト閾値が設定されていること

---

### Step 7: マイグレーションSQL作成

**作成するファイル:**
- `migrations/agent/0002_agent_hub.sql`

**内容:** 設計書v1.0.0のセクション3-2のCREATE TABLE SQL全文をそのまま使用する。
（6テーブル + インデックス + 初期データINSERT）

**完了条件:**
- [ ] 6テーブルのCREATE TABLE文が含まれていること
- [ ] systemユーザーとアキヤユーザーのINSERTが含まれていること
- [ ] 初期権限のINSERTが含まれていること
- [ ] インデックス作成が含まれていること

---

### Step 8: agent-hub/index.js 骨格作成

**作成するファイル:**
- `workers/agent-hub/index.js`

**内容:** ルーティング骨格のみ（〜100行程度）

```javascript
// COCOMI Agent Hub — エントリポイント・ルーティング
// Version: 1.0.0
'use strict';

export default {
  async fetch(request, env, ctx) {
    // 認証チェック
    const authToken = request.headers.get('X-Agent-Auth-Token');
    if (authToken !== env.AGENT_AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: '認証エラー' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // emergency_stop チェック（全書き込み系APIの入口）
    // TODO: Sprint 2で実装

    // ルーティング
    if (path === '/health' && request.method === 'GET') {
      return Response.json({ status: 'ok', version: '1.0.0' });
    }

    if (path === '/status' && request.method === 'GET') {
      // TODO: Sprint 2でコスト情報を含める
      return Response.json({ status: 'ok', message: 'agent-hub稼働中' });
    }

    // TODO: Sprint 4でタスクCRUDルーティング追加
    // POST /tasks, GET /tasks/:id, POST /tasks/:id/approve, etc.

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
```

**完了条件:**
- [ ] 認証チェックが実装されていること
- [ ] `/health`エンドポイントが応答すること
- [ ] `/status`エンドポイントが応答すること
- [ ] 500行以内であること
- [ ] 日本語コメントが含まれていること
- [ ] バージョン番号が記載されていること

---

### Step 9: shared/constants.js 作成

**作成するファイル:**
- `shared/constants.js`

**内容:**
```javascript
// COCOMI共通定数
// Version: 1.0.0

// agent-hubが所有するテーブル（書き込みOK）
export const AGENT_TABLES = [
  'users', 'permissions', 'proposals',
  'proposal_actions', 'cost_log', 'audit_log'
];

// 保護対象テーブル（agent-hubからはREAD ONLY）
export const PROTECTED_TABLES = [
  'memories', 'memory_metadata'
  // relay側の他テーブルが判明したら追加
];
```

**完了条件:**
- [ ] テーブルリストが設計書と一致すること

---

### Sprint 1 完了チェックリスト

- [ ] `workers/relay/`に既存6ファイルが移動済み
- [ ] `workers/relay/wrangler.toml`が存在し、既存バインディングを含む
- [ ] relay Workerのデプロイが成功し、既存機能が正常動作
- [ ] `workers/agent-hub/wrangler.toml`が存在
- [ ] `workers/agent-hub/index.js`が存在し、health/statusが応答
- [ ] `migrations/agent/0002_agent_hub.sql`が存在し、6テーブル+インデックス+初期データを含む
- [ ] `shared/constants.js`が存在
- [ ] 全ファイルが500行以内
- [ ] 全ファイルに日本語コメントとバージョン番号がある

---

## Sprint 2以降の概要（Sprint 1完了後に詳細化）

### Sprint 2: コスト管理（ブレーキ先）
- `shared/d1-helpers.js` — safeExecute()、SQL検査、保護テーブルガード
- `workers/agent-hub/cost.js` — コスト記録・日次/月次集計・閾値チェック・自動停止
- index.jsにemergency_stop / maintenance_modeチェック追加

### Sprint 3: 権限ガード + 監査ログ + relay連携
- `workers/agent-hub/permission.js` — resource/action単位の権限判定
- `workers/agent-hub/audit.js` — 監査ログ記録
- `workers/relay/index.js` に `/agent/*` プロキシ追加（〜10行）

### Sprint 4: タスクCRUD + 承認フロー
- `workers/agent-hub/task.js` — タスクCRUD・状態遷移
- `workers/agent-hub/executor.js` — タスク実行制御

### Sprint 5: 通知 + scheduler + UX改善
- `workers/agent-hub/scheduler.js` — stale task回収・Cron実行
- `workers/agent-hub/utils.js` — LINE Flex Message通知・ヘルパー
- health/status強化

---

作成: クロちゃん🔮（ブラウザ版）/ 2026-03-22
ソース: 三姉妹会議議事録(2026-03-21) + CLAUDE(5).md + 設計書v1.0.0 + 構想カプセルv0.3
