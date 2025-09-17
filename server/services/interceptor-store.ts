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
  // Optional static headers to inject on every upstream request (e.g., Authorization)
  injectHeaders?: Record<string, string>;
  // Map sessionId -> upstream messages endpoint URL (rewritten SSE support)
  sessionEndpoints: Map<string, string>;
};

class InterceptorStore {
  private interceptors: Map<string, InterceptorEntry> = new Map();
  private sessionIndex: Map<string, { interceptorId: string; url: string }> = new Map();

  create(targetUrl: string, injectHeaders?: Record<string, string>) {
    const id = randomUUID().slice(0, 8);
    const entry: InterceptorEntry = {
      id,
      targetUrl,
      createdAt: Date.now(),
      logs: [],
      subscribers: new Set(),
      injectHeaders,
      sessionEndpoints: new Map(),
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
      hasInjectedAuth: !!e.injectHeaders?.authorization,
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

  setSessionEndpoint(id: string, sessionId: string, url: string) {
    const e = this.interceptors.get(id);
    if (!e) return false;
    e.sessionEndpoints.set(sessionId, url);
    this.sessionIndex.set(sessionId, { interceptorId: id, url });
    return true;
  }

  getSessionEndpoint(id: string, sessionId: string): string | undefined {
    const e = this.interceptors.get(id);
    return e?.sessionEndpoints.get(sessionId);
  }

  getSessionMapping(sessionId: string): { interceptorId: string; url: string } | undefined {
    return this.sessionIndex.get(sessionId);
  }

  destroy(id: string): boolean {
    const e = this.interceptors.get(id);
    if (!e) return false;
    // Close and remove subscribers
    for (const sub of Array.from(e.subscribers)) {
      try { sub.send({ type: "closed" }); } catch {}
      try { sub.close(); } catch {}
    }
    e.subscribers.clear();
    // Remove session mappings for this interceptor
    for (const sid of Array.from(e.sessionEndpoints.keys())) {
      this.sessionIndex.delete(sid);
    }
    this.interceptors.delete(id);
    return true;
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
