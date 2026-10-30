-- 0001_create_events.sql — Marrow M1.1：事件溯源主表
--
-- 设计要点：
-- - sequence BIGSERIAL：事件全局唯一顺序（仅负责分配序号；
--   并发下提交顺序与哈希链顺序的一致性由事务级 advisory lock 保证，见 M1.2 写入路径）
-- - event_id UNIQUE：幂等约束，重复写入直接冲突失败
-- - event_hash / previous_event_hash 同时存在，构成哈希链
--   （链首事件的 previous_event_hash 为 NULL）
-- - schema_version：1 = 旧 JSONL 历史事件（无 schemaVersion 字段），2 = M1 起新写入事件
-- - payload JSONB：原始事件完整载荷，迁移时逐字节保留，不得改写
-- - 本阶段（M1.1）不创建任何记忆表，避免超前建设

CREATE TABLE IF NOT EXISTS events (
  sequence            BIGSERIAL    PRIMARY KEY,
  event_id            TEXT         NOT NULL UNIQUE,
  identity_id         TEXT         NOT NULL,
  "timestamp"         TIMESTAMPTZ  NOT NULL,
  event_type          TEXT         NOT NULL,
  schema_version      INTEGER      NOT NULL,
  engine_version      TEXT,
  causation_id        TEXT,
  correlation_id      TEXT,
  previous_event_hash TEXT,
  event_hash          TEXT         NOT NULL,
  payload             JSONB        NOT NULL
);

-- 按身份 + 全局顺序读取（loadEvents / 回放的主路径）
CREATE INDEX IF NOT EXISTS idx_events_identity_sequence
  ON events (identity_id, sequence);

-- 按类型过滤（回放分析、迁移校验用）
CREATE INDEX IF NOT EXISTS idx_events_type
  ON events (event_type);
