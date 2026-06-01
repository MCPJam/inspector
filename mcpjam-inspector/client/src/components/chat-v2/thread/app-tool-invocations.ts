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
