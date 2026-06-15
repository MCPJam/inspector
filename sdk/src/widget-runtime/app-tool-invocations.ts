/**
 * App-tool invocation lifecycle types (SEP-1865).
 *
 * The framework-free shape the host bridge produces as an app-initiated
 * `tools/call` moves through running → success / error. Lives in the SDK
 * widget-runtime so `host-app-bridge` (which emits these updates) and the
 * inspector renderer UI that displays them share one definition. The inspector
 * re-exports these from `client/src/components/chat-v2/thread/app-tool-invocations.ts`
 * for back-compat.
 */

export type AppToolInvocationStatus = "running" | "success" | "error";

export interface AppToolInvocation {
  id: string;
  parentToolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
  status: AppToolInvocationStatus;
  startedAt: number;
  completedAt?: number;
}

export type AppToolInvocationUpdate = AppToolInvocation;
