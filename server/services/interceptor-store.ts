import { randomUUID } from "crypto";

export type InterceptorLog =
  | {
      id: string;
      timestamp: number;
      direction: "request";
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: string;
    }
  | {
      id: string;
      timestamp: number;
      direction: "response";
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body?: string;
    };

type SseSubscriber = {
  send: (event: any) => void;
  close: () => void;
};

type InterceptorEntry = {
  id: string;
  targetUrl: string;
  createdAt: number;
  logs: InterceptorLog[];
  subscribers: Set<SseSubscriber>;
  // Optional manager-backed server identifier
  managerServerId?: string;
};

class InterceptorStore {
  private interceptors: Map<string, InterceptorEntry> = new Map();

  create(targetUrl: string, managerServerId?: string) {
    const id = randomUUID().slice(0, 8);
    const entry: InterceptorEntry = {
      id,
      targetUrl,
      createdAt: Date.now(),
      logs: [],
      subscribers: new Set(),
      managerServerId,
    };
    this.interceptors.set(id, entry);
    return entry;
  }

  get(id: string) {
    return this.interceptors.get(id);
  }

  info(id: string) {
    const e = this.interceptors.get(id);
    if (!e) return undefined;
    return {
      id: e.id,
      targetUrl: e.targetUrl,
      createdAt: e.createdAt,
      logCount: e.logs.length,
      managerServerId: e.managerServerId,
    };
  }

  clearLogs(id: string) {
    const e = this.interceptors.get(id);
    if (!e) return false;
    e.logs = [];
    this.broadcast(e, { type: "cleared" });
    return true;
  }

  appendLog(id: string, log: InterceptorLog) {
    const e = this.interceptors.get(id);
    if (!e) return false;
    e.logs.push(log);
    this.broadcast(e, { type: "log", log });
    return true;
  }

  listLogs(id: string) {
    const e = this.interceptors.get(id);
    return e?.logs ?? [];
  }

  subscribe(id: string, subscriber: SseSubscriber) {
    const e = this.interceptors.get(id);
    if (!e) return false;
    e.subscribers.add(subscriber);
    return () => {
      e.subscribers.delete(subscriber);
    };
  }

  private broadcast(e: InterceptorEntry, payload: any) {
    for (const sub of Array.from(e.subscribers)) {
      try {
        sub.send(payload);
      } catch {
        try {
          sub.close();
        } catch {}
        e.subscribers.delete(sub);
      }
    }
  }
}

export const interceptorStore = new InterceptorStore();


