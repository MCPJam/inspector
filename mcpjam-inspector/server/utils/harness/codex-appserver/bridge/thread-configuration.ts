import type {
  ThreadStartParams,
  ThreadStartResult,
} from "./app-server-protocol.js";

type ThreadRuntime = {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
};

/** Fork committed history when a catalog refresh requires a fresh thread. */
export function openConfiguredThread(
  runtime: ThreadRuntime,
  config: ThreadStartParams,
  previousThreadId: string | undefined,
  restart: boolean,
): Promise<ThreadStartResult> {
  return previousThreadId
    ? runtime.request<ThreadStartResult>(
        restart ? "thread/fork" : "thread/resume",
        {
          ...config,
          threadId: previousThreadId,
        },
      )
    : runtime.request<ThreadStartResult>("thread/start", config);
}
