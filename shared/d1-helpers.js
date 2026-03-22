// COCOMI Agent Hub — D1安全操作ラッパー
// Version: 1.0.0
// 全てのDB書き込みはこの関数経由で行うこと（CLAUDE.md準拠）
'use strict';

import { PROTECTED_TABLES } from './constants.js';

// === 禁止SQLパターン（設計書v1.0.0 セクション6-1準拠） ===
// DROP TABLE, ALTER TABLE, TRUNCATE は無条件禁止
// DELETE FROM は cost_log, audit_log, proposal_actions のみ許可（クリーンアップ用）
const FORBIDDEN_SQL_PATTERNS = [
  /DROP\s+TABLE/i,
  /ALTER\s+TABLE/i,
  /TRUNCATE/i,
  /DELETE\s+FROM\s+(?!cost_log|audit_log|proposal_actions)/i,
];

// === SQL検査関数 ===
// SQLが安全かチェック。禁止パターンに該当したらエラーをthrowする
export function validateSQL(sql) {
  for (const pattern of FORBIDDEN_SQL_PATTERNS) {
    if (pattern.test(sql)) {
      throw new Error(`[SECURITY] Forbidden SQL pattern: ${sql.substring(0, 80)}`);
    }
  }
}

// === 保護テーブルへの書き込み検出 ===
// INSERT/UPDATE/DELETE が PROTECTED_TABLES に対して実行されようとしていないかチェック
// SELECT は許可（agent-hubから保護テーブルの読み取りはOK）
export function checkProtectedTables(sql) {
  const normalizedSql = sql.replace(/\s+/g, ' ').trim();
  for (const table of PROTECTED_TABLES) {
    // INSERT INTO, UPDATE, DELETE FROM が保護テーブルに向いていたらブロック
    const writePatterns = [
      new RegExp(`INSERT\\s+INTO\\s+${table}`, 'i'),
      new RegExp(`UPDATE\\s+${table}`, 'i'),
      new RegExp(`DELETE\\s+FROM\\s+${table}`, 'i'),
    ];
    for (const pattern of writePatterns) {
      if (pattern.test(normalizedSql)) {
        throw new Error(`[SECURITY] Write to protected table blocked: ${table}`);
      }
    }
  }
}

// === 安全なDB実行ラッパー ===
// agent-hub内の全DB書き込みはこの関数経由で行うこと
// バリデーション → 実行 の順で処理する
export async function safeExecute(db, sql, params = []) {
  // 禁止パターンチェック
  validateSQL(sql);
  // 保護テーブルチェック
  checkProtectedTables(sql);

  try {
    const stmt = db.prepare(sql);
    if (params.length > 0) {
      return await stmt.bind(...params).run();
    }
    return await stmt.run();
  } catch (err) {
    console.error('[d1-helpers] safeExecute error:', err.message, 'SQL:', sql.substring(0, 80));
    throw err;
  }
}

// === 安全なDB読み取りラッパー ===
// SELECT専用。書き込み系SQLが紛れ込んでいないかチェック
export async function safeQuery(db, sql, params = []) {
  const trimmed = sql.trim().toUpperCase();
  // SELECTで始まらないSQLは拒否
  if (!trimmed.startsWith('SELECT')) {
    throw new Error(`[SECURITY] safeQuery accepts only SELECT statements: ${sql.substring(0, 80)}`);
  }

  try {
    const stmt = db.prepare(sql);
    if (params.length > 0) {
      return await stmt.bind(...params).all();
    }
    return await stmt.all();
  } catch (err) {
    console.error('[d1-helpers] safeQuery error:', err.message, 'SQL:', sql.substring(0, 80));
    throw err;
  }
}

// === ID生成ヘルパー ===
// タスクID等の一意ID生成（プレフィックス付きUUID形式）
// prefix があれば `${prefix}_${uuid}` 形式で返す
export function generateId(prefix = '') {
  const uuid = crypto.randomUUID();
  return prefix ? `${prefix}_${uuid}` : uuid;
}
