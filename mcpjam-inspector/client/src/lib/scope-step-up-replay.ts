import {
  SCOPE_STEP_UP_LIVE_TTL_MS,
  type StepUpOperationKey,
} from "@/shared/scope-step-up";

const PENDING_DIRECT_REPLAY_KEY = "mcp-scope-step-up-replay-v1";

export type DirectScopeStepUpReplayDescriptor =
  | {
      kind: "tool";
      surface: "tools" | "playground";
      serverName: string;
      toolName: string;
      parameters: Record<string, unknown>;
      taskOptions?: { ttl?: number };
      allowTaskResult?: boolean;
    }
  | {
      kind: "resource";
      surface: "resources";
      serverName: string;
      uri: string;
      target: "resource" | "template";
      /** Original UI selection (a URI template for template reads). */
      selection?: string;
    }
  | {
      kind: "prompt";
      surface: "prompts";
      serverName: string;
      promptName: string;
      arguments: Record<string, string>;
    };

export type PendingDirectScopeStepUpReplay = {
  version: 1;
  phase: "awaiting_oauth" | "ready" | "replaying";
  operation: StepUpOperationKey;
  descriptor: DirectScopeStepUpReplayDescriptor;
  returnPath: string;
  createdAt: number;
  expiresAt: number;
};

function readStored(): PendingDirectScopeStepUpReplay | undefined {
  try {
    const raw = sessionStorage.getItem(PENDING_DIRECT_REPLAY_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<PendingDirectScopeStepUpReplay>;
    if (
      value.version !== 1 ||
      (value.phase !== "awaiting_oauth" &&
        value.phase !== "ready" &&
        value.phase !== "replaying") ||
      !value.operation ||
      !value.descriptor ||
      typeof value.returnPath !== "string" ||
      typeof value.createdAt !== "number" ||
      typeof value.expiresAt !== "number"
    ) {
      sessionStorage.removeItem(PENDING_DIRECT_REPLAY_KEY);
      return undefined;
    }
    if (value.expiresAt <= Date.now()) {
      sessionStorage.removeItem(PENDING_DIRECT_REPLAY_KEY);
      return undefined;
    }
    return value as PendingDirectScopeStepUpReplay;
  } catch {
    sessionStorage.removeItem(PENDING_DIRECT_REPLAY_KEY);
    return undefined;
  }
}

function write(value: PendingDirectScopeStepUpReplay): void {
  sessionStorage.setItem(PENDING_DIRECT_REPLAY_KEY, JSON.stringify(value));
}

export function savePendingDirectScopeStepUpReplay(input: {
  operation: StepUpOperationKey;
  descriptor: DirectScopeStepUpReplayDescriptor;
}): void {
  const now = Date.now();
  write({
    version: 1,
    phase: "awaiting_oauth",
    operation: input.operation,
    descriptor: input.descriptor,
    returnPath:
      window.location.pathname + window.location.search + window.location.hash,
    createdAt: now,
    expiresAt: now + SCOPE_STEP_UP_LIVE_TTL_MS,
  });
}

export function markPendingDirectScopeStepUpReplayReady(
  serverName: string,
): void {
  const pending = readStored();
  if (!pending || pending.descriptor.serverName !== serverName) return;
  write({ ...pending, phase: "ready" });
}

export function cancelPendingDirectScopeStepUpReplay(
  serverName?: string,
): void {
  const pending = readStored();
  if (
    !pending ||
    (serverName && pending.descriptor.serverName !== serverName)
  ) {
    return;
  }
  sessionStorage.removeItem(PENDING_DIRECT_REPLAY_KEY);
}

export function claimPendingDirectScopeStepUpReplay(input: {
  serverName: string;
  surface: DirectScopeStepUpReplayDescriptor["surface"];
}): PendingDirectScopeStepUpReplay | undefined {
  const pending = readStored();
  if (
    !pending ||
    pending.phase !== "ready" ||
    pending.descriptor.serverName !== input.serverName ||
    pending.descriptor.surface !== input.surface
  ) {
    return undefined;
  }
  write({ ...pending, phase: "replaying" });
  return pending;
}

export function clearPendingDirectScopeStepUpReplay(): void {
  sessionStorage.removeItem(PENDING_DIRECT_REPLAY_KEY);
}
