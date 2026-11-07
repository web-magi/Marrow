/* Dashboard V1 — Runtime API fetch helpers
 *
 * 只读。全部 GET 请求。Runtime Base URL = 当前 origin（Vite dev server proxy 到 :8787）。
 *
 * DTO 通过 `import type` 共享自 Runtime 侧的 dashboard-api 契约模块：
 * 类型在构建期被擦除，不产生对 Runtime 代码的运行时依赖；
 * 这里不复制 Runtime 的状态管理逻辑，仅对齐 API 响应形状。
 */

import type { EventsListResponse, RuntimeStatusResponse } from '@marrow/dashboard-api';

export interface StateResponse {
  current: any;          // MarrowState（完整 26 字段）
  history: any[];        // MarrowState[]（最多 500 条）
  timeScale: number;
}

export type RuntimeResponse = RuntimeStatusResponse;
export type { EventsListResponse };

const BASE = ''; // 同 origin，Vite dev server proxy 到 Runtime

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(BASE + path);
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

export const api = {
  state: () => getJson<StateResponse>('/api/state'),
  runtime: () => getJson<RuntimeResponse>('/api/runtime'),
  /**
   * 事件查询（sequence 游标分页）。
   * beforeSequence：取更早的一页；afterSequence：取比游标更新的事件。
   * 响应仅含元数据 + 非敏感摘要（服务端白名单过滤）。
   */
  events: (params: {
    limit?: number;
    beforeSequence?: string;
    afterSequence?: string;
    type?: string | string[];
    since?: string;
    until?: string;
  } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.beforeSequence) qs.set('beforeSequence', params.beforeSequence);
    if (params.afterSequence) qs.set('afterSequence', params.afterSequence);
    const types = Array.isArray(params.type) ? params.type : (params.type ? [params.type] : []);
    for (const t of types) qs.append('type', t);
    if (params.since) qs.set('since', params.since);
    if (params.until) qs.set('until', params.until);
    const s = qs.toString();
    return getJson<EventsListResponse>('/api/events' + (s ? '?' + s : ''));
  },
  // 原始对话文本：localhost 边界内接口（服务端仅绑定 127.0.0.1）
  dialogue: () => getJson<any[]>('/api/dialogue'),
};
