/* Dashboard V1 — Runtime API fetch helpers
 *
 * 只读。全部 GET 请求。Runtime Base URL = 当前 origin（proxy 到 :8787）。
 */

export interface StateResponse {
  current: any;          // MarrowState（完整 26 字段）
  history: any[];        // MarrowState[]（最多 500 条）
  timeScale: number;
}

export interface RuntimeResponse {
  identityId: string;
  closed: boolean;
  uptimeSeconds: number;
  eventCount: number;
  tick: { pending: boolean; running: boolean; kind: string | null; recoveryRequired: boolean };
  queue: {
    active: number; reserved: number; ready: number; waiting: number; running: number;
    runningChatId: string | null; runningTaskKind: string | null;
  };
}

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
  events: (params: { limit?: number; offset?: number; type?: string; since?: string; until?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    if (params.type) qs.set('type', params.type);
    if (params.since) qs.set('since', params.since);
    if (params.until) qs.set('until', params.until);
    const s = qs.toString();
    return getJson<any[]>('/api/events' + (s ? '?' + s : ''));
  },
  dialogue: () => getJson<any[]>('/api/dialogue'),
};
