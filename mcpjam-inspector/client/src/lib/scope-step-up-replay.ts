import type { AuthChallengeAttempt } from "@/state/oauth-orchestrator";
import { readProjectPathSegment } from "@/lib/project-route";
import {
  SCOPE_STEP_UP_LIVE_TTL_MS,
  type StepUpOperationKey,
} from "@/shared/scope-step-up";
import {
  isStepUpCredentialBinding,
  settleStepUpCredential,
  type StepUpCredentialBinding,
} from "@/lib/scope-step-up-credential";

const PENDING_DIRECT_REPLAY_KEY = "mcp-scope-step-up-replay-v1";

export type DirectScopeStepUpReplayDescriptor = {
  authAttempt?: AuthChallengeAttempt;
} & (
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
    }
);

export type PendingDirectScopeStepUpReplay = {
  version: 1;
  callId?: string;
  generation?: number;
  projectId?: string;
  phase: "awaiting_oauth" | "ready" | "replaying";
  operation: StepUpOperationKey;
  descriptor: DirectScopeStepUpReplayDescriptor;
  returnPath: string;
  createdAt: number;
  expiresAt: number;
  /** Which credential the sign-in authorizes; see `scope-step-up-credential`. */
  credentialBinding?: StepUpCredentialBinding;
  /**
   * A digest of the authorization request's `state`, recorded right before
   * the redirect (never the state itself; see `authorizationFlowDigest`).
   * Only the callback for THIS flow may mark the call ready; another flow for
   * the same server cancels it instead of replaying it.
   */
  flowDigest?: string;
  /**
   * Set for a mid-session sign-in. A step-up leaves it absent.
   */
  reason?: "authorization_required";
};

function readStored(): PendingDirectScopeStepUpReplay | undefined {
  try {
    const raw = sessionStorage.getItem(PENDING_DIRECT_REPLAY_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<PendingDirectScopeStepUpReplay>;
    if (
      value.version !== 1 ||
      (value.callId !== undefined &&
        (typeof value.callId !== "string" || !value.callId)) ||
      (value.generation !== undefined &&
        (!Number.isSafeInteger(value.generation) || value.generation < 1)) ||
      (value.projectId !== undefined && typeof value.projectId !== "string") ||
      (value.phase !== "awaiting_oauth" &&
        value.phase !== "ready" &&
        value.phase !== "replaying") ||
      !value.operation ||
      !value.descriptor ||
      typeof value.returnPath !== "string" ||
      typeof value.createdAt !== "number" ||
      typeof value.expiresAt !== "number" ||
      (value.credentialBinding !== undefined &&
        !isStepUpCredentialBinding(value.credentialBinding)) ||
      (value.flowDigest !== undefined &&
        typeof value.flowDigest !== "string") ||
      (value.reason !== undefined && value.reason !== "authorization_required")
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
    return undefined;
  }
}

function write(value: PendingDirectScopeStepUpReplay): void {
  const raw = JSON.stringify(value);
  sessionStorage.setItem(PENDING_DIRECT_REPLAY_KEY, raw);
  if (sessionStorage.getItem(PENDING_DIRECT_REPLAY_KEY) !== raw)
    throw new Error("Could not save the call for sign-in. Try again.");
}

// Calls whose sign-in this page is driving. A call saved by an earlier page
// (the tab reloaded, or came back with Back from the authorization server)
// was abandoned: a completed sign-in returns to the callback, which settles
// it. Such a call gives way to the next one instead of blocking it.
const drivenByThisPage = new Set<string>();
if (typeof window !== "undefined") {
  window.addEventListener("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) drivenByThisPage.clear();
  });
}

/** The `/p/<id>` project of the current page, or "local" outside one. */
function currentProjectSegment(): string {
  return readProjectPathSegment(window.location.pathname) ?? "local";
}

/**
 * A saved call runs only in its own project, the page's. A record written
 * before calls carried a project names it only in the page it returns to.
 */
function belongsToCurrentProject(
  pending: PendingDirectScopeStepUpReplay,
): boolean {
  const project = currentProjectSegment();
  const saved =
    pending.projectId ?? readProjectPathSegment(pending.returnPath) ?? "local";
  return (
    saved === project &&
    (!pending.descriptor.authAttempt ||
      pending.descriptor.authAttempt.projectId === project)
  );
}

export class PendingDirectReplayConflictError extends Error {
  constructor(waiting: "signed_in_on_this_server" | "signing_in") {
    super(
      waiting === "signed_in_on_this_server"
        ? "A call on this server is waiting to run again after sign-in. Open the page you started it from to run it, then try again."
        : "Another call is waiting for sign-in. Finish that sign-in or wait for it to expire, then try again.",
    );
    this.name = "PendingDirectReplayConflictError";
  }
}

export function savePendingDirectScopeStepUpReplay(input: {
  operation: StepUpOperationKey;
  descriptor: DirectScopeStepUpReplayDescriptor;
  reason?: "authorization_required";
  previous?: PendingDirectScopeStepUpReplay;
}): PendingDirectScopeStepUpReplay {
  const now = Date.now();
  const previous = input.previous;
  const waiting = readStored();
  if (!previous && waiting && waiting.expiresAt > now) {
    // A signed-in call keeps its slot against calls on its own server in its
    // own project, where it replays. A call anywhere else takes the slot: the
    // user moved on, and the store holds one call.
    if (
      waiting.phase === "ready" &&
      waiting.descriptor.serverName === input.descriptor.serverName &&
      belongsToCurrentProject(waiting)
    )
      throw new PendingDirectReplayConflictError("signed_in_on_this_server");
    // A call this page is signing in or replaying keeps its slot too; one an
    // earlier page left waiting or replaying was abandoned.
    if (
      waiting.phase !== "ready" &&
      waiting.callId !== undefined &&
      drivenByThisPage.has(waiting.callId)
    )
      throw new PendingDirectReplayConflictError("signing_in");
  }
  if (previous) {
    const current = readStored();
    if (
      !current ||
      !sameGeneration(current, previous) ||
      current.phase !== "replaying"
    )
      throw new Error("This call is no longer waiting for sign-in. Please try again.");
  }
  const value: PendingDirectScopeStepUpReplay = {
    version: 1,
    callId:
      previous?.callId ?? input.descriptor.authAttempt?.callId ?? crypto.randomUUID(),
    generation: (previous?.generation ?? 0) + 1,
    projectId:
      previous?.projectId ?? input.descriptor.authAttempt?.projectId ??
      currentProjectSegment(),
    phase: "awaiting_oauth",
    operation: input.operation,
    descriptor: input.descriptor,
    returnPath:
      previous?.returnPath ??
      window.location.pathname + window.location.search + window.location.hash,
    createdAt: previous?.createdAt ?? now,
    expiresAt: previous?.expiresAt ?? now + SCOPE_STEP_UP_LIVE_TTL_MS,
    ...(input.reason ? { reason: input.reason } : {}),
  };
  write(value);
  if (value.callId) drivenByThisPage.add(value.callId);
  return value;
}

/** Bind the saved call to the authorization flow it waits on. */
export function setPendingDirectScopeStepUpReplayFlowDigest(
  serverName: string,
  flowDigest: string,
  expected?: PendingDirectScopeStepUpReplay,
): void {
  const pending = readStored();
  if (expected && (!pending || !sameGeneration(pending, expected)))
    throw new Error("This call is no longer waiting for sign-in. Run it again.");
  if (
    !pending ||
    pending.phase !== "awaiting_oauth" ||
    pending.descriptor.serverName !== serverName
  ) {
    return;
  }
  write({ ...pending, flowDigest });
}

export const SIGNED_IN_FOR_ANOTHER_REQUEST_MESSAGE =
  "Signed in. Run the call again.";

/** Record which credential the pending sign-in authorizes. */
export function setPendingDirectScopeStepUpReplayCredentialBinding(
  serverName: string,
  binding: StepUpCredentialBinding,
  expected?: PendingDirectScopeStepUpReplay,
): void {
  const pending = readStored();
  if (expected && (!pending || !sameGeneration(pending, expected)))
    throw new Error("This call is no longer waiting for sign-in. Run it again.");
  if (!pending || pending.descriptor.serverName !== serverName) return;
  write({ ...pending, credentialBinding: binding });
}

/**
 * Settle the saved direct call after an OAuth callback that reported the
 * credential it produced. Returns the cancellation message when the call must
 * not be replayed (a different or shared credential), so the caller can say
 * so; `undefined` when it was marked ready or nothing was pending.
 */
export function settlePendingDirectScopeStepUpReplayAfterCallback(
  serverName: string,
  callbackCredentialId: string | undefined,
  callbackDigest?: string,
): string | undefined {
  const pending = readStored();
  if (
    !pending ||
    pending.phase !== "awaiting_oauth" ||
    pending.descriptor.serverName !== serverName
  )
    return undefined;
  // Bound to its flow: a callback for a different authorization request (an
  // older tab, a second Connect) must not replay this call's saved arguments.
  if (
    !pending.flowDigest ||
    !callbackDigest ||
    pending.flowDigest !== callbackDigest
  ) {
    return SIGNED_IN_FOR_ANOTHER_REQUEST_MESSAGE;
  }
  const settled = settleStepUpCredential(
    pending.credentialBinding,
    callbackCredentialId,
  );
  if (settled.outcome === "replay") {
    write({ ...pending, phase: "ready" });
    return undefined;
  }
  sessionStorage.removeItem(PENDING_DIRECT_REPLAY_KEY);
  return settled.message;
}

export function markPendingDirectScopeStepUpReplayReady(
  serverName: string,
  callbackDigest?: string,
): void {
  const pending = readStored();
  if (
    !pending ||
    pending.phase !== "awaiting_oauth" ||
    pending.descriptor.serverName !== serverName
  )
    return;
  // A call bound to its flow is marked ready only by that flow's callback.
  // A surface that saved the call without binding a flow keeps the
  // one-pending-call rule: the next successful sign-in for the server.
  if (pending.flowDigest && pending.flowDigest !== callbackDigest) return;
  write({ ...pending, phase: "ready" });
}

/** Inspect the saved call without claiming its replay. */
export function peekPendingDirectScopeStepUpReplay():
  PendingDirectScopeStepUpReplay | undefined {
  return readStored();
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
    !belongsToCurrentProject(pending) ||
    pending.descriptor.serverName !== input.serverName ||
    pending.descriptor.surface !== input.surface
  ) {
    return undefined;
  }
  write({ ...pending, phase: "replaying" });
  if (pending.callId) drivenByThisPage.add(pending.callId);
  return pending;
}

export function clearPendingDirectScopeStepUpReplay(
  expected?: PendingDirectScopeStepUpReplay,
): void {
  if (expected) {
    const current = readStored();
    if (
      !current ||
      !sameGeneration(current, expected)
    )
      return;
  }
  sessionStorage.removeItem(PENDING_DIRECT_REPLAY_KEY);
}

function sameGeneration(
  a: PendingDirectScopeStepUpReplay,
  b: PendingDirectScopeStepUpReplay,
): boolean {
  return a.callId === b.callId && a.generation === b.generation &&
    a.createdAt === b.createdAt &&
    JSON.stringify(a.descriptor.authAttempt) === JSON.stringify(b.descriptor.authAttempt);
}
