# COCOMI Agent Hub — Step Instructions v1.1.0 (Sprint 2)

<!-- Document Version: v1.1.0 -->
<!-- Sprint 2: コスト管理（ブレーキ先）— 安全機構を実行機能より先に作る -->
<!-- 前提: Sprint 1完了済み（コミット e7ee0f0）、D1に10テーブル投入済み、Secret設定済み -->
<!-- CLAUDE.md v1.0.0 と 設計書 v1.0.0 を必ず先に読んでから作業すること -->

## 全体方針
- **ブレーキをアクセルより先に作る**（構想カプセルv0.3: クロちゃんの安全原則）
- Sprint 2で作るのは: SQL安全ガード → コスト管理 → emergency_stop/maintenance_mode
- D1テーブルは全て投入済み（agent_config含む）。マイグレーション不要
- 500行ルール厳守、日本語コメント必須、バージョン番号付与
- **d1-helpers.jsのsafeExecute()を経由しないDB書き込みは禁止**（CLAUDE.md準拠）

## Sprint 1からの引き継ぎ状態
- `workers/relay/` — 既存6ファイル + wrangler.toml（変更なし）
- `workers/agent-hub/index.js` — 91行、認証 + health + status
- `workers/agent-hub/wrangler.toml` — D1バインディング + コスト閾値環境変数 + AGENT_AUTH_TOKEN Secret
- `shared/constants.js` — 68行 → v1.0.1で agent_config, agent_checkpoints 追加済み
- `migrations/agent/0002_agent_hub.sql` — 129行（6テーブル + インデックス + 初期データ）
- D1テーブル: 10テーブル投入済み（agent_config に emergency_stop=false, maintenance_mode=false, low_cost_mode=false の初期データあり）

## D1 agent_config テーブルの現在のデータ
```
key: 'emergency_stop', value: 'false', updated_by: 'system'
key: 'maintenance_mode', value: 'false', updated_by: 'system'
key: 'low_cost_mode', value: 'false', updated_by: 'system'
```

## wrangler.toml の環境変数（既に設定済み）
```
DAILY_COST_HARD_LIMIT_MICRO_USD = "1000000"    # $1.00
MONTHLY_COST_HARD_LIMIT_MICRO_USD = "10000000"  # $10.00
DAILY_COST_SOFT_LIMIT_MICRO_USD = "700000"      # $0.70
ENVIRONMENT = "production"
```
Secret: `AGENT_AUTH_TOKEN` = 設定済み

---

## Step 1: shared/d1-helpers.js の作成

**作成するファイル:**
- `shared/d1-helpers.js`

**役割:** agent-hub全体のDB操作を安全にするガードレール。全てのDB書き込みはこの関数経由で行う。

**実装要件:**

```javascript
// COCOMI Agent Hub — D1安全操作ラッパー
// Version: 1.0.0
'use strict';

import { AGENT_TABLES, PROTECTED_TABLES } from './constants.js';

// === 禁止SQLパターン（設計書v1.0.0 セクション6-1準拠） ===
const FORBIDDEN_SQL_PATTERNS = [
  /DROP\s+TABLE/i,
  /ALTER\s+TABLE/i,
  /TRUNCATE/i,
  // 保護対象テーブルへのDELETE禁止（cost_log, audit_log, proposal_actionsは許可）
  /DELETE\s+FROM\s+(?!cost_log|audit_log|proposal_actions)/i,
];

// === SQL検査関数 ===
// SQLが安全かチェック。禁止パターンに該当したらエラーをthrowする
export function validateSQL(sql) {
  // 実装: FORBIDDEN_SQL_PATTERNSの全パターンをテスト
  // マッチしたら throw new Error(`[SECURITY] Forbidden SQL pattern: ${sql.substring(0, 80)}`);
}

// === 保護テーブルへの書き込み検出 ===
// INSERT/UPDATE/DELETE が PROTECTED_TABLES に対して実行されようとしていないかチェック
export function checkProtectedTables(sql) {
  // PROTECTED_TABLES の各テーブル名について、INSERT INTO / UPDATE / DELETE FROM がマッチしたらエラー
  // SELECT は許可（agent-hubから保護テーブルの読み取りはOK）
}

// === 安全なDB実行ラッパー ===
// agent-hub内の全DB書き込みはこの関数経由で行うこと
export async function safeExecute(db, sql, params = []) {
  // 1. validateSQL(sql) で禁止パターンチェック
  // 2. checkProtectedTables(sql) で保護テーブルチェック
  // 3. 問題なければ db.prepare(sql).bind(...params).run() を実行
  // 4. エラー時はログ出力して再throw
}

// === 安全なDB読み取りラッパー ===
// SELECT専用。書き込み系SQLが紛れ込んでいないかチェック
export async function safeQuery(db, sql, params = []) {
  // 1. SQLがSELECTで始まるか確認（そうでなければエラー）
  // 2. db.prepare(sql).bind(...params).all() を実行
}

// === ID生成ヘルパー ===
// タスクID等の一意ID生成（プレフィックス付きUUID形式）
export function generateId(prefix = '') {
  // crypto.randomUUID() を使用
  // prefix があれば `${prefix}_${uuid}` 形式
}
```

**重要なポイント:**
- `DELETE FROM`の禁止は`cost_log`, `audit_log`, `proposal_actions`を**除外**する（これらはagent-hub所有テーブルでクリーンアップが必要なため）
- `PROTECTED_TABLES`（memories, memory_metadata）への書き込み系は全てブロック
- `safeExecute`を通さないDB書き込みはCLAUDE.md違反

**完了条件:**
- [ ] `shared/d1-helpers.js`が存在すること
- [ ] `validateSQL()`が禁止SQLパターンを検出すること
- [ ] `checkProtectedTables()`が保護テーブルへの書き込みを検出すること
- [ ] `safeExecute()`がバリデーション→実行の順で処理すること
- [ ] `safeQuery()`がSELECT以外を拒否すること
- [ ] `generateId()`がプレフィックス付きUUIDを返すこと
- [ ] 500行以内であること
- [ ] 日本語コメントとバージョン番号があること

---

## Step 2: shared/constants.js の更新

**変更するファイル:**
- `shared/constants.js`

**追加内容:**
```javascript
// === コスト制御定数（構想カプセルv0.3 + 設計書v1.0.0 セクション5準拠） ===

// タスク種別ごとのコスト上限（micro_usd）
export const TASK_COST_LIMITS = {
  light_research: 100000,   // 軽調査 $0.10
  deep_research: 500000,    // 深掘り $0.50
  meeting: 1000000,         // 会議 $1.00
};

// コスト日次/月次キー生成ヘルパー
// daily_key: 'YYYYMMDD', monthly_key: 'YYYYMM'
export function getDailyKey(date = new Date()) {
  // JST変換して YYYYMMDD 形式で返す
}
export function getMonthlyKey(date = new Date()) {
  // JST変換して YYYYMM 形式で返す
}

// === タスク状態定義 ===
export const PROPOSAL_STATUSES = [
  'draft', 'submitted', 'revision_requested', 'approved', 'rejected',
  'scheduled', 'running', 'paused', 'completed', 'failed', 'cancelled', 'stopped'
];

// === 監査ログアクション定義 ===
export const AUDIT_ACTIONS = [
  'task_created', 'task_approved', 'task_started', 'task_completed', 'task_failed',
  'permission_denied', 'cost_limit_hit', 'cost_soft_warning',
  'emergency_stop', 'maintenance_mode_on', 'maintenance_mode_off',
  'system_error'
];
```

**注意:** 既存の`AGENT_TABLES`と`PROTECTED_TABLES`は変更しない。追加のみ。

**完了条件:**
- [ ] `TASK_COST_LIMITS`が3種類の上限を定義していること
- [ ] `getDailyKey()`がYYYYMMDD形式を返すこと（JSTで）
- [ ] `getMonthlyKey()`がYYYYMM形式を返すこと（JSTで）
- [ ] `PROPOSAL_STATUSES`が設計書の12状態と一致すること
- [ ] `AUDIT_ACTIONS`が設計書セクション1-6の項目を含むこと
- [ ] 既存の定義が壊れていないこと
- [ ] 500行以内であること
- [ ] バージョン番号が`1.1.0`に更新されていること

---

## Step 3: workers/agent-hub/cost.js の作成

**作成するファイル:**
- `workers/agent-hub/cost.js`

**役割:** コスト記録・集計・閾値チェック・自動停止。agent-hubのブレーキ機構の心臓部。

**実装要件:**

```javascript
// COCOMI Agent Hub — コスト管理モジュール
// Version: 1.0.0
// 設計書v1.0.0 セクション5 + 構想カプセルv0.3 コスト制御に準拠
'use strict';

import { safeExecute, safeQuery, generateId } from '../../shared/d1-helpers.js';
import { TASK_COST_LIMITS, getDailyKey, getMonthlyKey } from '../../shared/constants.js';

// === コスト記録 ===
// API呼び出し後にトークン数×単価でコストを計算し、cost_logに記録する
export async function recordCost(db, {
  proposalId,      // タスクID（nullable: システム処理の場合null）
  actionType,      // 'llm_call', 'embedding', 'search' 等
  provider,        // 'anthropic', 'openai', 'google'
  model,           // 'claude-haiku-4-5', 'gpt-4o-mini' 等
  inputTokens,     // 入力トークン数
  outputTokens,    // 出力トークン数
  costMicroUsd,    // コスト（micro_usd単位: $1.00 = 1,000,000）
  metadata         // 追加情報（JSON化される）
}) {
  // 1. generateId('cost') でID生成
  // 2. getDailyKey() と getMonthlyKey() でキー生成
  // 3. safeExecute() で cost_log に INSERT
  // 4. proposalId がある場合、proposals.actual_cost_micro_usd を加算 UPDATE
  // 5. 閾値チェックを実行（checkCostLimits）
  // 6. 結果を返す（超過警告があれば含める）
}

// === 日次コスト集計 ===
export async function getDailyCost(db, dailyKey = null) {
  // cost_log テーブルから daily_key でSUM(cost_micro_usd)を取得
  // dailyKey未指定時は今日の日次キーを使用
}

// === 月次コスト集計 ===
export async function getMonthlyCost(db, monthlyKey = null) {
  // cost_log テーブルから monthly_key でSUM(cost_micro_usd)を取得
}

// === 閾値チェック（3層コスト制御） ===
export async function checkCostLimits(db, env) {
  // 1. 日次コスト取得
  // 2. 月次コスト取得
  // 3. env から閾値を取得:
  //    - DAILY_COST_SOFT_LIMIT_MICRO_USD ($0.70)
  //    - DAILY_COST_HARD_LIMIT_MICRO_USD ($1.00)
  //    - MONTHLY_COST_HARD_LIMIT_MICRO_USD ($10.00)
  // 4. 判定結果を返す:
  //    { dailyCost, monthlyCost, status: 'ok' | 'soft_warning' | 'hard_stop',
  //      reason: '...', shouldStop: boolean }
  //
  // 判定ロジック:
  //   月次 >= ハード → hard_stop（全停止）
  //   日次 >= ハード → hard_stop（全停止）
  //   日次 >= ソフト → soft_warning（通知のみ、処理は継続）
  //   それ以外 → ok
}

// === 自動停止実行 ===
// ハード上限到達時にemergency_stopを有効化する
export async function activateEmergencyStop(db, reason) {
  // 1. agent_config テーブルの emergency_stop を 'true' に更新
  // 2. audit_log に 'emergency_stop' アクションを記録
  // 3. 実行中の全タスク（proposals.status = 'running'）を 'stopped' に更新
  //    stop_reason に理由を記録
  // 4. TODO: Sprint 5でLINE通知を追加
}

// === コストステータス取得（/status API用） ===
export async function getCostStatus(db, env) {
  // 日次/月次コストと閾値情報をまとめて返す
  // { daily: { cost, softLimit, hardLimit, percentage },
  //   monthly: { cost, hardLimit, percentage },
  //   status: 'ok' | 'soft_warning' | 'hard_stop' }
}
```

**micro_usd単位について（設計書セクション5-2）:**
- $1.00 = 1,000,000 micro_usd
- INTEGER型で保存するため小数点以下の誤差なし
- 環境変数もmicro_usd単位で設定済み

**重要なポイント:**
- `recordCost`は呼ばれるたびに`checkCostLimits`も実行する（常にブレーキ監視）
- ハード上限到達時は`activateEmergencyStop`を呼んで全停止する
- ソフト上限はログ記録＋返り値で通知するが停止はしない
- 全DB操作は`safeExecute`/`safeQuery`経由

**完了条件:**
- [ ] `recordCost()`がcost_logにINSERTしproposalsのactual_costを更新すること
- [ ] `getDailyCost()`が日次合計を返すこと
- [ ] `getMonthlyCost()`が月次合計を返すこと
- [ ] `checkCostLimits()`が3段階（ok/soft_warning/hard_stop）で判定すること
- [ ] `activateEmergencyStop()`がagent_configを更新し全タスクを停止すること
- [ ] `getCostStatus()`がステータスAPIで使える形式のデータを返すこと
- [ ] 全DB操作がsafeExecute/safeQuery経由であること
- [ ] 500行以内であること
- [ ] 日本語コメントとバージョン番号があること

---

## Step 4: workers/agent-hub/audit.js の作成

**作成するファイル:**
- `workers/agent-hub/audit.js`

**役割:** 監査ログ記録。全ての重要な操作を記録する。Sprint 3で本格利用するが、cost.jsとindex.jsから呼ぶためSprint 2で先行作成。

**実装要件:**

```javascript
// COCOMI Agent Hub — 監査ログモジュール
// Version: 1.0.0
// 設計書v1.0.0 セクション1-6 + セクション3-2 audit_logテーブルに準拠
'use strict';

import { safeExecute, generateId } from '../../shared/d1-helpers.js';

// === 監査ログ記録 ===
export async function writeAuditLog(db, {
  actorUserId,     // 操作者のユーザーID（'system' or 'akiya'）
  action,          // AUDIT_ACTIONS の値
  resourceType,    // 'proposal', 'config', 'permission', 'cost' 等
  resourceId,      // 対象リソースのID（nullable）
  detail,          // 詳細情報（オブジェクト→JSON化）
  ipAddress        // IPアドレス（nullable）
}) {
  // 1. generateId('audit') でID生成
  // 2. detail をJSON.stringify
  // 3. safeExecute() で audit_log にINSERT
  // 4. エラー時も主処理をブロックしない（try-catchで握りつぶし＋console.error）
  //    ※ CLAUDE.md「通知処理の失敗は主処理をブロックしない」準拠
}

// === 監査ログ取得（管理用） ===
export async function getAuditLogs(db, { limit = 20, resourceType, action } = {}) {
  // フィルタ条件付きで audit_log を取得（新しい順）
}
```

**重要: audit.jsはtry-catchで囲む。** 監査ログの書き込み失敗で主処理が止まってはいけない（CLAUDE.md「通知処理の失敗は主処理をブロックしない」）。

**完了条件:**
- [ ] `writeAuditLog()`がaudit_logにINSERTすること
- [ ] エラー時もthrowせず、console.errorで記録すること
- [ ] `getAuditLogs()`がフィルタ付きで取得できること
- [ ] 全DB操作がsafeExecute/safeQuery経由であること
- [ ] 500行以内であること（100行以内に収まるはず）
- [ ] 日本語コメントとバージョン番号があること

---

## Step 5: workers/agent-hub/index.js の更新

**変更するファイル:**
- `workers/agent-hub/index.js`

**変更内容:**
1. emergency_stop / maintenance_mode チェック追加（全リクエストの入口）
2. コストステータスを /status に組み込み
3. /emergency-stop エンドポイント追加
4. コスト関連エンドポイント追加

**実装要件:**

```javascript
// COCOMI Agent Hub — エントリポイント・ルーティング
// Version: 1.1.0（Sprint 2: コスト管理 + emergency_stop追加）
'use strict';

import { getCostStatus, checkCostLimits } from './cost.js';
import { writeAuditLog } from './audit.js';
import { safeQuery } from '../../shared/d1-helpers.js';

export default {
  async fetch(request, env, ctx) {
    const db = env.DB;

    // === 認証チェック（Sprint 1から変更なし） ===
    const authToken = request.headers.get('X-Agent-Auth-Token');
    if (authToken !== env.AGENT_AUTH_TOKEN) {
      return Response.json({ error: '認証エラー' }, { status: 401 });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // === emergency_stop / maintenance_mode チェック ===
    // GETリクエスト以外（書き込み系）の入口で必ずチェック
    if (method !== 'GET') {
      // agent_config から emergency_stop と maintenance_mode を取得
      // emergency_stop === 'true' → 全書き込み拒否（/emergency-stop の解除のみ許可）
      // maintenance_mode === 'true' → 全書き込み拒否
      // 拒否時は audit_log に記録
    }

    // === ルーティング ===

    // ヘルスチェック
    if (path === '/health' && method === 'GET') {
      return Response.json({ status: 'ok', version: '1.1.0' });
    }

    // ステータス（コスト情報含む）
    if (path === '/status' && method === 'GET') {
      // getCostStatus() でコスト情報取得
      // agent_config から emergency_stop, maintenance_mode 取得
      // 稼働中タスク件数（proposals WHERE status='running'）
      // pending approval 件数
      // 全部まとめて返す
    }

    // 緊急停止（POST /emergency-stop）
    if (path === '/emergency-stop' && method === 'POST') {
      // body から { action: 'activate' | 'deactivate' } を取得
      // activate: emergency_stop = 'true' に設定 + 全running停止
      // deactivate: emergency_stop = 'false' に設定
      // audit_log に記録
    }

    // コストステータス（GET /cost/status — 詳細版）
    if (path === '/cost/status' && method === 'GET') {
      // getCostStatus() の結果を返す
    }

    // TODO: Sprint 4でタスクCRUDルーティング追加

    return Response.json({ error: 'Not Found' }, { status: 404 });
  }
};
```

**emergency_stopの解除について:**
- `/emergency-stop` に `{ "action": "deactivate" }` をPOSTすると解除
- emergency_stop中でも `/emergency-stop` エンドポイント自体は常にアクセス可能にする（解除できなくなるため）
- 解除はownerロール（アキヤ）のみ可能とする（Phase 1ではトークン認証で代用）

**完了条件:**
- [ ] GET以外のリクエストでemergency_stop/maintenance_modeをチェックすること
- [ ] `/status`がコスト情報・タスク件数・フラグ情報を返すこと
- [ ] `/emergency-stop`が停止と解除の両方に対応すること
- [ ] `/cost/status`がコスト詳細を返すこと
- [ ] emergency_stop中でも/emergency-stopと/health,/statusにはアクセスできること
- [ ] 500行以内であること
- [ ] バージョン番号が`1.1.0`に更新されていること

---

## Step 6: 統合テスト用のcurlコマンド

**テスト手順（デプロイ後にTermuxから実行）:**

```bash
# 基本ヘルスチェック
curl -s -H "X-Agent-Auth-Token: cocomi-agent-2026-secret" \
  https://cocomi-agent-hub.{account}.workers.dev/health | jq .

# ステータス確認（コスト情報含む）
curl -s -H "X-Agent-Auth-Token: cocomi-agent-2026-secret" \
  https://cocomi-agent-hub.{account}.workers.dev/status | jq .

# コスト詳細
curl -s -H "X-Agent-Auth-Token: cocomi-agent-2026-secret" \
  https://cocomi-agent-hub.{account}.workers.dev/cost/status | jq .

# 緊急停止テスト（activate）
curl -s -X POST \
  -H "X-Agent-Auth-Token: cocomi-agent-2026-secret" \
  -H "Content-Type: application/json" \
  -d '{"action":"activate"}' \
  https://cocomi-agent-hub.{account}.workers.dev/emergency-stop | jq .

# 緊急停止解除テスト（deactivate）
curl -s -X POST \
  -H "X-Agent-Auth-Token: cocomi-agent-2026-secret" \
  -H "Content-Type: application/json" \
  -d '{"action":"deactivate"}' \
  https://cocomi-agent-hub.{account}.workers.dev/emergency-stop | jq .

# 認証エラーテスト（トークンなし）
curl -s https://cocomi-agent-hub.{account}.workers.dev/health | jq .
# → { "error": "認証エラー" } が返ること

# emergency_stop中の書き込み拒否テスト
# 1. まずactivate
# 2. POST /agent/tasks（Sprint 4で実装するが、404が返る前にemergency_stopで弾かれることを確認）
# 3. deactivateで解除
```

**注意:** `{account}` は実際のCloudflareアカウントのサブドメインに置き換える。

**完了条件:**
- [ ] /health が `{"status":"ok","version":"1.1.0"}` を返すこと
- [ ] /status がコスト情報とフラグ情報を含むこと
- [ ] /emergency-stop activate → emergency_stop有効化 → /status で確認
- [ ] emergency_stop中にPOSTリクエストが拒否されること
- [ ] /emergency-stop deactivate → emergency_stop解除 → /status で確認

---

## Sprint 2 完了チェックリスト

- [ ] `shared/d1-helpers.js` が存在し、safeExecute/safeQuery/validateSQL/checkProtectedTablesが実装されている
- [ ] `shared/constants.js` がv1.1.0に更新され、コスト定数・状態定義・監査アクション定義が追加されている
- [ ] `workers/agent-hub/cost.js` が存在し、コスト記録・集計・閾値チェック・自動停止が実装されている
- [ ] `workers/agent-hub/audit.js` が存在し、監査ログ記録が実装されている（エラー時も主処理を止めない）
- [ ] `workers/agent-hub/index.js` がv1.1.0に更新され、emergency_stop/maintenance_modeチェック・コストAPI・緊急停止APIが追加されている
- [ ] 全ファイルが500行以内
- [ ] 全ファイルに日本語コメントとバージョン番号がある
- [ ] 全DB書き込みがsafeExecute()経由
- [ ] 保護テーブル（memories, memory_metadata）への書き込みがブロックされる
- [ ] curlでヘルス・ステータス・緊急停止のテストが通る

---

## Sprint 2で作成/変更するファイル一覧

| ファイル | 操作 | 想定行数 |
|---------|------|---------|
| `shared/d1-helpers.js` | 新規作成 | ~120行 |
| `shared/constants.js` | 更新（v1.0.1 → v1.1.0） | ~120行 |
| `workers/agent-hub/cost.js` | 新規作成 | ~200行 |
| `workers/agent-hub/audit.js` | 新規作成 | ~60行 |
| `workers/agent-hub/index.js` | 更新（v1.0.0 → v1.1.0） | ~180行 |

合計: 新規3ファイル + 更新2ファイル、全体約680行の追加

---

## Sprint 3以降の概要（Sprint 2完了後に詳細化）

### Sprint 3: 権限ガード + 監査ログ強化 + relay連携
- `workers/agent-hub/permission.js` — resource/action単位の権限判定
- `workers/agent-hub/audit.js` 強化 — 権限チェック結果の記録
- `workers/relay/index.js` に `/agent/*` プロキシ追加（~10行）
- Sprint 3終了時にService Binding再評価

### Sprint 4: タスクCRUD + 承認フロー
### Sprint 5: 通知 + scheduler + UX改善

---

作成: クロちゃん🔮（ブラウザ版）/ 2026-03-22
ソース: 設計書v1.0.0 + CLAUDE.md v1.0.0 + 構想カプセルv0.3 + 安全ガイド + step-instructions v1.0.0
