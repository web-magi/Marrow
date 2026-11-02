-- 0002_chain_integrity.sql — Marrow M1.2.2：哈希链完整性数据库约束
--
-- 目的：把"同一身份的事件链不分叉"从代码约定升级为数据库不变量。
-- advisory lock 已经串行化同一身份的写入，但数据库层再加一道防线：
-- - 任意前驱哈希在同一身份下只能被一个事件引用（禁止分叉）
-- - 每个身份最多一个 genesis 事件（previous_event_hash 为 NULL）
--
-- 使用部分唯一索引，不影响其他身份/普通插入；
-- 若历史数据已存在分叉，迁移会失败并暴露问题（当前 V2 事件流为空或健康）。

CREATE UNIQUE INDEX IF NOT EXISTS uniq_events_identity_prev_hash
  ON events (identity_id, previous_event_hash)
  WHERE previous_event_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_events_identity_genesis
  ON events (identity_id)
  WHERE previous_event_hash IS NULL;
