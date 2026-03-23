# COCOMI Agent Hub — Step Instructions v1.2.0 (Sprint 3)

<!-- Document Version: v1.2.0 -->
<!-- Sprint 3: 権限ガード + 監査ログ強化 + relay→agent中継 -->
<!-- 前提: Sprint 2完了済み（コミット 9ae0486）、curlテスト全項目OK -->
<!-- CLAUDE.md v1.0.0 と 設計書 v1.0.0 を必ず先に読んでから作業すること -->

## 全体方針
- Sprint 3は「誰が何をできるか」を制御する権限の仕組みを作る
- ブレーキ（Sprint 2）の上に、ハンドル（権限）を載せるイメージ
- relay→agent中継を追加し、フロントエンドからagent操作可能にする布石
- Sprint 3終了時にService Binding再評価（HTTP fetch暫定方式の継続 or 切替判断）
- 500行ルール厳守、日本語コメント必須、バージョン番号付与
- 全DB書き込みはsafeExecute()経由（CLAUDE.md準拠）

## Sprint 2からの引き継ぎ状態

### ファイル構成（現在）
```
cocomi-api-relay/
├── workers/
│   ├── relay/
│   │   ├── index.js       # ~300行（エントリポイント）
│   │   ├── memory.js       # 468行 v1.17
│   │   ├── import.js       # 253行 v1.4
│   │   ├── vector.js       # ~200行
│   │   ├── search.js       # ~150行
│   │   ├── utils.js        # ~145行
│   │   └── wrangler.toml
│   └── agent-hub/
│       ├── index.js        # 233行 v1.1.0
│       ├── cost.js         # 203行 v1.0.0
│       ├── audit.js        # 62行 v1.0.0
│       └── wrangler.toml
├── shared/
│   ├── constants.js        # 117行 v1.1.0
│   └── d1-helpers.js       # 96行 v1.0.0
├── migrations/
│   └── agent/0002_agent_hub.sql  # 129行
└── .github/workflows/
    └── deploy-worker.yml   # 84行 v3.0
```

### D1テーブルの現状
permissionsテーブルには以下の初期データが投入済み（0002_agent_hub.sql）：
```sql
-- ownerは全操作許可
INSERT OR IGNORE INTO permissions (id, subject_type, subject_id, resource, action, effect, ...)
VALUES ('perm_owner_all', 'role', 'owner', '*', '*', 'allow', ...);

-- systemはstopのみ
VALUES ('perm_system_stop', 'user', 'system', 'proposal', 'stop', 'allow', ...);
VALUES ('perm_system_auto_stop', 'user', 'system', 'proposal', 'system_auto_stop', 'allow', ...);
```

usersテーブルには以下が投入済み：
```sql
-- systemユーザー（role: admin）
-- akiyaユーザー（role: owner）
```

### 認証情報
- agent-hub: `X-Agent-Auth-Token` ヘッダで認証（Secret: AGENT_AUTH_TOKEN）
- relay: `X-COCOMI-AUTH` ヘッダで認証（Secret: COCOMI_AUTH_TOKEN = cocomi-family-2026-secret）
- relay→agent-hub間通信: agent-hub側の `AGENT_AUTH_TOKEN` を relay の環境変数にも追加する必要あり

### Worker URL
- relay: `cocomi-api-relay.k-akiyaman.workers.dev`
- agent-hub: `cocomi-agent-hub.k-akiyaman.workers.dev`

---

## Step 1: workers/agent-hub/permission.js の作成

**作成するファイル:**
- `workers/agent-hub/permission.js`

**役割:** リクエストのユーザーが指定されたリソース・アクションに対して許可されているか判定する。permissionsテーブルとusersテーブルを参照。

**実装要件:**

```javascript
// COCOMI Agent Hub — 権限判定モジュール
// Version: 1.0.0
// 設計書v1.0.0 セクション1-5 + セクション3-2 permissionsテーブルに準拠
'use strict';

import { safeQuery } from '../../shared/d1-helpers.js';

// === ユーザー取得 ===
// ユーザーIDからusersテーブルの情報を取得
export async function getUser(db, userId) {
  // safeQuery で users テーブルから取得
  // 見つからなければ null を返す
  // 返り値: { id, line_user_id, display_name, role, status, timezone }
}

// === 権限判定メイン関数 ===
// 指定のユーザーが、指定のリソース・アクションを実行できるか判定
export async function checkPermission(db, {
  userId,       // ユーザーID（'akiya', 'system' 等）
  resource,     // リソース種別（'proposal', 'config', 'cost' 等）
  action        // アクション（'create', 'approve', 'stop', 'read' 等）
}) {
  // 1. ユーザー情報取得（getUser）
  //    - ユーザーが存在しない → deny
  //    - ユーザーのstatusが'inactive' → deny
  //
  // 2. permissionsテーブルを検索
  //    以下の条件でマッチするレコードを探す（優先順位あり）:
  //
  //    a) ユーザー単位の明示的なdeny（最優先）
  //       subject_type='user', subject_id=userId, resource=対象, action=対象, effect='deny'
  //
  //    b) ロール単位の明示的なdeny
  //       subject_type='role', subject_id=user.role, resource=対象, action=対象, effect='deny'
  //
  //    c) ユーザー単位のallow
  //       subject_type='user', subject_id=userId, resource=対象, action=対象, effect='allow'
  //
  //    d) ロール単位のallow
  //       subject_type='role', subject_id=user.role, resource=対象, action=対象, effect='allow'
  //
  //    ※ resource='*' と action='*' はワイルドカードとしてマッチ
  //    ※ deny > allow（明示的なdenyがあればallowより優先）
  //    ※ user > role（ユーザー単位の設定がロール単位より優先）
  //
  // 3. マッチするallowが見つかれば { allowed: true, reason: '...' }
  //    見つからなければ { allowed: false, reason: 'No matching permission' }
  //
  // 4. 判定結果を返す:
  //    { allowed: boolean, userId, role, resource, action, reason }
}

// === 権限チェック + 監査ログ統合ヘルパー ===
// checkPermissionを呼んで、拒否された場合はaudit_logに記録する
// index.jsの各エンドポイントで使う想定
export async function requirePermission(db, { userId, resource, action }) {
  // 1. checkPermission を呼ぶ
  // 2. allowed === false の場合:
  //    - writeAuditLog で 'permission_denied' を記録
  //    - { allowed: false, response: Response.json({ error: '権限がありません', ... }, { status: 403 }) } を返す
  // 3. allowed === true の場合:
  //    - { allowed: true } を返す
}
```

**権限判定の優先順位（設計書セクション1-5準拠）:**
1. emergency_stop中 → 全書き込み拒否（これはindex.jsで既にチェック済み）
2. maintenance_mode中 → read-only（これもindex.jsで既にチェック済み）
3. ユーザー単位のdeny → 最優先で拒否
4. ロール単位のdeny → 拒否
5. ユーザー単位のallow → 許可
6. ロール単位のallow → 許可
7. どれにもマッチしない → デフォルト拒否（安全側に倒す）

**ワイルドカードマッチのSQL例:**
```sql
SELECT * FROM permissions
WHERE (subject_type = 'user' AND subject_id = ?)
   OR (subject_type = 'role' AND subject_id = ?)
AND ((resource = ? OR resource = '*')
 AND (action = ? OR action = '*'))
ORDER BY
  CASE effect WHEN 'deny' THEN 0 ELSE 1 END,
  CASE subject_type WHEN 'user' THEN 0 ELSE 1 END
LIMIT 1;
```

**完了条件:**
- [ ] `getUser()` がusersテーブルからユーザー情報を取得できること
- [ ] `checkPermission()` がdeny > allow、user > roleの優先順位で判定すること
- [ ] ワイルドカード（resource='*', action='*'）が正しくマッチすること
- [ ] ユーザーが存在しない/inactiveの場合にdenyを返すこと
- [ ] `requirePermission()` が拒否時にaudit_logに記録すること
- [ ] 全DB操作がsafeQuery経由であること
- [ ] 500行以内であること
- [ ] 日本語コメントとバージョン番号があること

---

## Step 2: workers/agent-hub/audit.js の強化

**変更するファイル:**
- `workers/agent-hub/audit.js`（v1.0.0 → v1.1.0）

**追加内容:**

```javascript
// COCOMI Agent Hub — 監査ログモジュール
// Version: 1.1.0（Sprint 3: 権限チェック記録 + リクエストログ追加）

// === 既存の writeAuditLog は変更なし ===

// === リクエストログ記録（新規追加） ===
// 全リクエストの概要を監査ログに記録する
// index.jsの入口で呼ばれる想定
export async function logRequest(db, {
  method,         // HTTPメソッド
  path,           // リクエストパス
  userId,         // 認証されたユーザーID（未認証なら'anonymous'）
  ipAddress,      // IPアドレス
  resultStatus    // レスポンスのHTTPステータスコード
}) {
  // writeAuditLog を呼ぶ
  // action: 'api_request'
  // resourceType: 'api'
  // resourceId: `${method} ${path}`
  // detail: { method, path, resultStatus }
  //
  // ※ エラーでも主処理をブロックしない（try-catch）
  // ※ GETリクエストはログ量が増えるのでPhase 1では記録しない（POSTのみ）
}

// === 監査ログ取得の強化（フィルタ追加） ===
export async function getAuditLogs(db, {
  limit = 20,
  resourceType,
  action,
  actorUserId,    // 新規: ユーザーIDでフィルタ
  since           // 新規: この日時以降のログ（ISO形式）
} = {}) {
  // 既存のフィルタに actorUserId と since を追加
  // WHERE句を動的に構築
}
```

**重要:** audit.jsは62行→100行程度の増加を見込む。try-catchのルールは維持。

**完了条件:**
- [ ] `logRequest()` がPOSTリクエストの概要をaudit_logに記録すること
- [ ] `getAuditLogs()` が actorUserId と since でフィルタできること
- [ ] エラー時も主処理をブロックしないこと
- [ ] バージョンが v1.1.0 に更新されていること
- [ ] 500行以内であること

---

## Step 3: workers/agent-hub/index.js の更新

**変更するファイル:**
- `workers/agent-hub/index.js`（v1.1.0 → v1.2.0）

**変更内容:**
1. 各エンドポイントにrequirePermission()チェック追加
2. ユーザー特定ロジック追加（Phase 1: トークン→akiya固定）
3. POSTリクエストのリクエストログ記録
4. 監査ログ取得エンドポイント追加

**実装要件:**

```javascript
// COCOMI Agent Hub — エントリポイント・ルーティング
// Version: 1.2.0（Sprint 3: 権限ガード + 監査ログ強化）
'use strict';

import { getCostStatus } from './cost.js';
import { writeAuditLog, logRequest, getAuditLogs } from './audit.js';
import { requirePermission } from './permission.js';
import { safeQuery } from '../../shared/d1-helpers.js';

export default {
  async fetch(request, env, ctx) {
    const db = env.DB;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // === 認証チェック（変更なし） ===
    const authToken = request.headers.get('X-Agent-Auth-Token');
    if (authToken !== env.AGENT_AUTH_TOKEN) {
      return Response.json({ error: '認証エラー' }, { status: 401 });
    }

    // === ユーザー特定 ===
    // Phase 1: トークン認証が通った = akiya（ownerロール）
    // Sprint 4以降でLINE user_id等による動的ユーザー特定に拡張
    const currentUserId = 'akiya';

    // === emergency_stop / maintenance_mode チェック（既存、変更なし） ===
    // ...

    // === ルーティング ===

    // /health — 権限チェック不要
    if (path === '/health' && method === 'GET') {
      return Response.json({ status: 'ok', version: '1.2.0', worker: 'agent-hub' });
    }

    // /status — 読み取りのみ、権限チェック
    if (path === '/status' && method === 'GET') {
      const perm = await requirePermission(db, {
        userId: currentUserId, resource: 'status', action: 'read'
      });
      if (!perm.allowed) return perm.response;
      // 既存のステータス取得ロジック
    }

    // /emergency-stop — 権限チェック（停止/解除）
    if (path === '/emergency-stop' && method === 'POST') {
      const body = await request.json();
      const action = body.action === 'activate' ? 'stop' : 'stop';
      const perm = await requirePermission(db, {
        userId: currentUserId, resource: 'config', action: 'emergency_stop'
      });
      if (!perm.allowed) return perm.response;
      // 既存の停止/解除ロジック
      // リクエストログ記録
      ctx.waitUntil(logRequest(db, { method, path, userId: currentUserId, resultStatus: 200 }));
    }

    // /cost/status — 読み取り、権限チェック
    if (path === '/cost/status' && method === 'GET') {
      const perm = await requirePermission(db, {
        userId: currentUserId, resource: 'cost', action: 'read'
      });
      if (!perm.allowed) return perm.response;
      // 既存のコストステータス取得
    }

    // 【新規】/audit/logs — 監査ログ取得
    if (path === '/audit/logs' && method === 'GET') {
      const perm = await requirePermission(db, {
        userId: currentUserId, resource: 'audit', action: 'read'
      });
      if (!perm.allowed) return perm.response;
      const params = Object.fromEntries(url.searchParams);
      const logs = await getAuditLogs(db, {
        limit: parseInt(params.limit) || 20,
        action: params.action,
        resourceType: params.resource_type,
        actorUserId: params.actor,
        since: params.since
      });
      return Response.json({ status: 'ok', logs });
    }

    return Response.json({ error: 'Not Found' }, { status: 404 });
  }
};
```

**Phase 1のユーザー特定について:**
- Phase 1ではトークン認証が通れば全て`akiya`（owner）として扱う
- ownerは`perm_owner_all`（'*'/'*'/allow）で全操作許可なので、実質的に権限チェックは常にpass
- しかし仕組みとして入れておくことで、Sprint 4以降で動的ユーザー特定に拡張しやすくなる
- 権限がdenyされるケースは、将来user/viewerロールを追加した時に初めて発生する

**完了条件:**
- [ ] 各エンドポイントにrequirePermission()チェックが入っていること
- [ ] /health は権限チェック不要のままであること
- [ ] POSTリクエストでリクエストログが記録されること
- [ ] /audit/logs が監査ログをフィルタ付きで取得できること
- [ ] バージョンが v1.2.0 に更新されていること
- [ ] 500行以内であること

---

## Step 4: shared/constants.js の更新

**変更するファイル:**
- `shared/constants.js`（v1.1.0 → v1.2.0）

**追加内容:**

```javascript
// === 権限関連定数（Sprint 3追加） ===

// リソース種別一覧
export const RESOURCES = [
  'proposal', 'config', 'cost', 'audit', 'status', 'permission'
];

// アクション種別一覧
export const ACTIONS = [
  'create', 'read', 'update', 'delete',
  'approve', 'reject', 'cancel',
  'stop', 'emergency_stop',
  'submit', 'start', 'pause', 'resume', 'complete', 'fail'
];

// AUDIT_ACTIONS に追加
// 既存の AUDIT_ACTIONS 配列に以下を追加:
//   'permission_denied', 'api_request'
// （permission_deniedは既にあるかもしれないので重複チェック）
```

**完了条件:**
- [ ] RESOURCES と ACTIONS が定義されていること
- [ ] AUDIT_ACTIONS に 'api_request' が追加されていること
- [ ] 既存の定義が壊れていないこと
- [ ] バージョンが v1.2.0 に更新されていること

---

## Step 5: relay側に /agent/* プロキシ追加

**変更するファイル:**
- `workers/relay/index.js`

**変更内容:** relay Workerに届いた `/agent/*` パスのリクエストを、agent-hub Workerに転送するプロキシを追加する。

**実装要件:**

```javascript
// workers/relay/index.js 内の fetch ハンドラに追加
// 既存のルーティングの前に配置

// === agent-hub プロキシ（Sprint 3追加） ===
// /agent/* へのリクエストをagent-hub Workerに転送
if (url.pathname.startsWith('/agent/')) {
  // 1. パスから '/agent' プレフィックスを除去
  //    例: /agent/health → /health
  //    例: /agent/status → /status
  //    例: /agent/emergency-stop → /emergency-stop
  const agentPath = url.pathname.replace(/^\/agent/, '');

  // 2. agent-hub Worker URLを構築
  const agentUrl = `https://cocomi-agent-hub.k-akiyaman.workers.dev${agentPath}${url.search}`;

  // 3. 認証ヘッダを付け替え
  //    relay側のCOCOMI_AUTH_TOKENで認証された後なので、
  //    agent-hub側のAGENT_AUTH_TOKENに差し替える
  const agentHeaders = new Headers(request.headers);
  agentHeaders.set('X-Agent-Auth-Token', env.AGENT_AUTH_TOKEN);
  // relay側の認証ヘッダは削除（不要）
  agentHeaders.delete('X-COCOMI-AUTH');

  // 4. fetch で転送
  const agentResponse = await fetch(agentUrl, {
    method: request.method,
    headers: agentHeaders,
    body: ['GET', 'HEAD'].includes(request.method) ? null : request.body
  });

  // 5. レスポンスをそのまま返す（CORSヘッダ追加が必要な場合あり）
  const responseHeaders = new Headers(agentResponse.headers);
  responseHeaders.set('Access-Control-Allow-Origin', 'https://akiyamanx.github.io');

  return new Response(agentResponse.body, {
    status: agentResponse.status,
    headers: responseHeaders
  });
}
```

**重要: relay側のwrangler.tomlにAGENT_AUTH_TOKENを追加する必要がある。**
```toml
# workers/relay/wrangler.toml に追加
# [vars] セクションには入れない（Secretとして管理）
# wrangler secret put AGENT_AUTH_TOKEN --config workers/relay/wrangler.toml
# または Cloudflareダッシュボードから手動設定
```

ただしTermuxではwrangler secretが使えないので、**Cloudflareダッシュボードでrelay Workerの環境変数にAGENT_AUTH_TOKENを追加する**必要がある。値はagent-hubと同じ`cocomi-agent-2026-secret`。

**CORSについて:**
relay側には既にCORS処理があるはずだが、agent-hubからの転送レスポンスにもCORSヘッダが付くことを確認する。プロキシ部分で明示的にAccess-Control-Allow-Originを付けるのが安全。

**完了条件:**
- [ ] `/agent/health` → agent-hubの `/health` に転送されること
- [ ] `/agent/status` → agent-hubの `/status` に転送されること
- [ ] `/agent/emergency-stop` → agent-hubの `/emergency-stop` に転送されること
- [ ] 認証ヘッダがrelay側（X-COCOMI-AUTH）→agent-hub側（X-Agent-Auth-Token）に正しく変換されること
- [ ] CORSヘッダが付与されること
- [ ] 既存のrelayルーティングが壊れていないこと
- [ ] relay側のwrangler.toml/環境変数にAGENT_AUTH_TOKENが設定されていること（手動で設定）

---

## Step 6: 統合テスト用のcurlコマンド

**テスト手順（デプロイ後にTermuxから実行。chrootの外で。）**

```bash
# === 直接アクセステスト（agent-hub） ===

# 1. ヘルスチェック（バージョン確認）
curl -s -H "X-Agent-Auth-Token: cocomi-agent-2026-secret" \
  https://cocomi-agent-hub.k-akiyaman.workers.dev/health
# 期待: {"status":"ok","version":"1.2.0","worker":"agent-hub"}

# 2. ステータス確認（権限チェック通過）
curl -s -H "X-Agent-Auth-Token: cocomi-agent-2026-secret" \
  https://cocomi-agent-hub.k-akiyaman.workers.dev/status
# 期待: 正常なステータスJSON

# 3. 監査ログ取得
curl -s -H "X-Agent-Auth-Token: cocomi-agent-2026-secret" \
  "https://cocomi-agent-hub.k-akiyaman.workers.dev/audit/logs?limit=5"
# 期待: {"status":"ok","logs":[...]}（先ほどのcurlテストの記録が見えるはず）

# 4. 監査ログ フィルタ付き取得
curl -s -H "X-Agent-Auth-Token: cocomi-agent-2026-secret" \
  "https://cocomi-agent-hub.k-akiyaman.workers.dev/audit/logs?action=emergency_stop&limit=5"
# 期待: emergency_stopの記録のみ

# 5. emergency-stop activate → 監査ログ確認
curl -s -X POST \
  -H "X-Agent-Auth-Token: cocomi-agent-2026-secret" \
  -H "Content-Type: application/json" \
  -d '{"action":"activate"}' \
  https://cocomi-agent-hub.k-akiyaman.workers.dev/emergency-stop
# → すぐ解除
curl -s -X POST \
  -H "X-Agent-Auth-Token: cocomi-agent-2026-secret" \
  -H "Content-Type: application/json" \
  -d '{"action":"deactivate"}' \
  https://cocomi-agent-hub.k-akiyaman.workers.dev/emergency-stop
# → 監査ログ確認
curl -s -H "X-Agent-Auth-Token: cocomi-agent-2026-secret" \
  "https://cocomi-agent-hub.k-akiyaman.workers.dev/audit/logs?limit=5"
# 期待: activate, deactivateの記録が見える

# === relay経由アクセステスト ===

# 6. relay経由でagent-hub health
curl -s -H "X-COCOMI-AUTH: cocomi-family-2026-secret" \
  -H "Origin: https://akiyamanx.github.io" \
  https://cocomi-api-relay.k-akiyaman.workers.dev/agent/health
# 期待: {"status":"ok","version":"1.2.0","worker":"agent-hub"}

# 7. relay経由でagent-hub status
curl -s -H "X-COCOMI-AUTH: cocomi-family-2026-secret" \
  -H "Origin: https://akiyamanx.github.io" \
  https://cocomi-api-relay.k-akiyaman.workers.dev/agent/status
# 期待: 正常なステータスJSON（CORSヘッダ付き）

# 8. relay経由でagent-hub audit/logs
curl -s -H "X-COCOMI-AUTH: cocomi-family-2026-secret" \
  -H "Origin: https://akiyamanx.github.io" \
  "https://cocomi-api-relay.k-akiyaman.workers.dev/agent/audit/logs?limit=3"
# 期待: {"status":"ok","logs":[...]}

# === エラーケーステスト ===

# 9. 認証なしでrelay経由アクセス
curl -s https://cocomi-api-relay.k-akiyaman.workers.dev/agent/health
# 期待: 認証エラー（relay側で弾かれる）

# 10. 認証なしで直接agent-hubアクセス
curl -s https://cocomi-agent-hub.k-akiyaman.workers.dev/health
# 期待: {"error":"認証エラー"}
```

**注意:**
- curlテストはchrootの外（普通のTermux）から実行
- relay経由テスト（#6-8）の前に、Cloudflareダッシュボードでrelay WorkerにAGENT_AUTH_TOKEN環境変数を追加しておくこと

---

## Sprint 3 完了チェックリスト

- [ ] `workers/agent-hub/permission.js` が存在し、checkPermission/requirePermissionが実装されている
- [ ] deny > allow、user > roleの優先順位で判定する
- [ ] ワイルドカード（'*'）がリソース・アクション両方でマッチする
- [ ] `workers/agent-hub/audit.js` がv1.1.0に更新され、logRequest/getAuditLogs強化が追加されている
- [ ] `workers/agent-hub/index.js` がv1.2.0に更新され、各エンドポイントにrequirePermission()が入っている
- [ ] /audit/logs エンドポイントが追加されている
- [ ] `shared/constants.js` がv1.2.0に更新され、RESOURCES/ACTIONS定数が追加されている
- [ ] `workers/relay/index.js` に /agent/* プロキシが追加されている
- [ ] relay側の環境変数にAGENT_AUTH_TOKENが設定されている
- [ ] 全ファイルが500行以内
- [ ] 全ファイルに日本語コメントとバージョン番号がある
- [ ] 全DB操作がsafeExecute/safeQuery経由
- [ ] curlでagent-hub直接 + relay経由のテストが通る
- [ ] Sprint 3終了時のService Binding再評価メモを残す

---

## Sprint 3で作成/変更するファイル一覧

| ファイル | 操作 | 想定行数 |
|---------|------|---------:|
| `workers/agent-hub/permission.js` | 新規作成 | ~150行 |
| `workers/agent-hub/audit.js` | 更新（v1.0.0 → v1.1.0） | ~100行 |
| `workers/agent-hub/index.js` | 更新（v1.1.0 → v1.2.0） | ~300行 |
| `shared/constants.js` | 更新（v1.1.0 → v1.2.0） | ~130行 |
| `workers/relay/index.js` | 更新（+~30行） | 既存+30行 |

合計: 新規1ファイル + 更新4ファイル

---

## Service Binding再評価メモ（Sprint 3完了時に判断）

**現状:** HTTP fetch + 共有認証トークン方式
**Service Bindingの利点:**
- Worker間通信がCloudflare内部ネットワークで完結（レイテンシ削減）
- 外部URLを叩かない（セキュリティ向上）
- 認証トークンの受け渡しが不要

**Service Bindingの懸念:**
- wrangler.tomlの設定変更が必要（Termuxで直接wranglerが使えない問題）
- デプロイ順序に依存が生まれる可能性
- Phase 1の規模ではHTTP fetchで十分な可能性が高い

**判断基準:** relay→agent-hub間のレイテンシが体感で気にならなければHTTP fetch継続。Sprint 5（通知+scheduler）で頻繁な内部通信が必要になったら再検討。

---

## Sprint 4以降の概要（Sprint 3完了後に詳細化）

### Sprint 4: タスクCRUD + 承認フロー
- `workers/agent-hub/task.js` — タスクCRUD（create/get/list）
- `workers/agent-hub/executor.js` — タスク実行制御（start/complete/fail）
- 承認フロー（submit→approve/reject→scheduled→running→completed）
- LINE Flex Messageの承認ボタン（Sprint 5と連携）

### Sprint 5: 通知 + scheduler + UX改善
- `workers/agent-hub/scheduler.js` — Cron/stale回収
- LINE Flex Message通知
- UX改善（温度感のある通知文面）

---

作成: クロちゃん🔮（ブラウザ版）/ 2026-03-23
ソース: 設計書v1.0.0 + CLAUDE.md v1.0.0 + 構想カプセルv0.3 + step-instructions v1.1.0 + Sprint 2実装結果
