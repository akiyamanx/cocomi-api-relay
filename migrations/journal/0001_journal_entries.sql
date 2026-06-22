-- 0001_journal_entries.sql
-- COCOMI ジャーナリング自律エージェント Phase 1: journal_entries テーブル作成
-- Version: 1.0.0
-- 設計書: cocomi-capsules/designs/ジャーナリング自律エージェント_統合設計書_v1.0_2026-06-19.md §9 準拠
-- 配置: D1 = cocomi-memory (binding=DB, id=1b164b3b-a737-4721-aa07-86d6c821c8e6)
--
-- 役割:
--   アキヤが入力した「今日の出来事」1件ごとに、安全チェック結果(zone) と
--   AIが選んだ保存先(action) ・振り返り(reflection) ・小さな一歩(todo) を残す最小テーブル。
--   既存の memory / consultation 系テーブルとは独立。Phase 1 はアキヤ専用なので user_id 列は持たない。
--
-- カラム設計の意図:
--   - id            : テキスト主キー(UUID/ULID等を呼び出し側で生成)
--   - date          : 出来事の日付 (YYYY-MM-DD)。created_at とは別に「いつの出来事か」を保持
--   - raw_text      : アキヤが入力した原文。後から再分析できるよう必ず生で残す
--   - zone          : 安全チェック結果。green / yellow / red のいずれか
--   - action        : 保存判断。memory / safezone のいずれか。red時は保留=NULL可
--   - reflection    : AIが作った振り返り文。red時は固定危機レスポンスを入れない=NULL可
--   - todo          : 小さな一歩(任意)。yellow/red時はNULL可
--   - created_at    : 行作成時刻(UTC ISO8601)

CREATE TABLE IF NOT EXISTS journal_entries (
  id          TEXT    PRIMARY KEY,
  date        TEXT    NOT NULL,
  raw_text    TEXT    NOT NULL,
  zone        TEXT    NOT NULL CHECK (zone IN ('green', 'yellow', 'red')),
  action      TEXT             CHECK (action IS NULL OR action IN ('memory', 'safezone')),
  reflection  TEXT,
  todo        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 索引:
--   date          : 「先月の同じ日」「直近N日」の参照用
--   zone          : yellow/red の頻度モニタリング用(運用観点)
--   created_at    : 一覧の時系列ソート用
CREATE INDEX IF NOT EXISTS idx_journal_entries_date       ON journal_entries(date);
CREATE INDEX IF NOT EXISTS idx_journal_entries_zone       ON journal_entries(zone);
CREATE INDEX IF NOT EXISTS idx_journal_entries_created_at ON journal_entries(created_at);
