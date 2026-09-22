import { create } from "zustand";

export interface EvalToolMetadata {
  name: string;
  description?: string;
  inputSchema?: unknown;
  serverId?: string;
  _meta?: Record<string, unknown>;
}
export interface MetadataTarget {
  projectId: string;
  environmentKey: string;
  serverIds: string[];
}
export interface ServerMetadata {
  serverId: string;
  status: "loading" | "ready" | "empty" | "error";
  tools: EvalToolMetadata[];
  action?: "reconnect" | "retry";
  updatedAt: number;
}
export interface MetadataSnapshot {
  environmentKey: string;
  servers: ServerMetadata[];
  tools: EvalToolMetadata[];
}
const FRESH_MS = 60_000;
const pending = new Map<string, Promise<void>>();
export const useEvalToolMetadata = create<{
  entries: Record<string, ServerMetadata>;
}>(() => ({ entries: {} }));
function key(target: MetadataTarget, serverId: string) {
  return JSON.stringify([target.projectId, target.environmentKey, serverId]);
}
function publish(key: string, entry: ServerMetadata) {
  useEvalToolMetadata.setState((s) => ({
    entries: Object.fromEntries(
      Object.entries({ ...s.entries, [key]: entry }).slice(-128),
    ),
  }));
}
export function readEvalToolMetadata(target: MetadataTarget): MetadataSnapshot {
  const entries = useEvalToolMetadata.getState().entries;
  const servers = [...new Set(target.serverIds)].map(
    (serverId) =>
      entries[key(target, serverId)] ?? {
        serverId,
        status: "loading" as const,
        tools: [],
        updatedAt: 0,
      },
  );
  return {
    environmentKey: target.environmentKey,
    servers,
    tools: servers.flatMap((server) => server.tools),
  };
}
function needsReconnect(error: unknown) {
  const status = (error as { status?: number })?.status;
  return (
    status === 401 ||
    status === 403 ||
    /unauthorized|forbidden|oauth|authentication|sign.?in|\b401\b|\b403\b/i.test(
      String(error),
    )
  );
}
type Loader = (serverId: string) => Promise<{ tools?: EvalToolMetadata[] }>;
async function withTimeout<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Tool metadata timed out")),
          12_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** Publish independently; failures never erase another server's successful catalogue. */
export async function loadEvalToolMetadata(
  target: MetadataTarget,
  load: Loader,
  force = false,
) {
  const ids = [...new Set(target.serverIds)];
  let index = 0;
  const loadOne = (serverId: string): Promise<void> => {
    const id = key(target, serverId);
    const inFlight = pending.get(id);
    if (inFlight) return inFlight;
    const cached = useEvalToolMetadata.getState().entries[id];
    if (
      !force &&
      cached &&
      cached.status !== "loading" &&
      Date.now() - cached.updatedAt < FRESH_MS
    )
      return Promise.resolve();
    publish(id, {
      serverId,
      status: "loading",
      tools: [],
      updatedAt: Date.now(),
    });
    const request = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await withTimeout(load(serverId));
          const tools = (response.tools ?? []).map((tool) => ({
            ...tool,
            serverId,
          }));
          publish(id, {
            serverId,
            status: tools.length ? "ready" : "empty",
            tools,
            updatedAt: Date.now(),
          });
          return;
        } catch (error) {
          const reconnect = needsReconnect(error);
          if (attempt === 0 && !reconnect) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          publish(id, {
            serverId,
            status: "error",
            tools: [],
            action: reconnect ? "reconnect" : "retry",
            updatedAt: Date.now(),
          });
          return;
        }
      }
    })().finally(() => pending.delete(id));
    pending.set(id, request);
    return request;
  };
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (index < ids.length) await loadOne(ids[index++]);
    }),
  );
}
