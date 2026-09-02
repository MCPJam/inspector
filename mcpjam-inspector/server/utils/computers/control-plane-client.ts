/**
 * Convex control-plane client for Project Computers.
 *
 * The inspector server is the DATA plane (it holds `E2B_API_KEY` and the live
 * exec/PTY connections); Convex owns the durable rows. This module wraps the
 * backend's `/computers/*` HTTP routes (mcpjam-backend
 * `convex/computersDataPlane.ts`), reached via `CONVEX_HTTP_URL` like
 * `scenario-runtime-config.ts` does:
 *
 *   reserve           user-bearer auth — reserve/wake/poll the acting user's
 *                     computer (idempotent; each poll also counts as activity)
 *   sandbox-info      service-token auth — Convex row id → vendor sandbox id.
 *                     The token marks us as the deployed server; browsers
 *                     must never be able to make this exchange.
 *   commands          service-token auth — durable command log (idempotent)
 *   terminal-sessions service-token auth — session open/close records
 */
import { logger } from "../logger.js";
import { type ExecutionScope } from "../execution-scope.js";

export type ComputerStatus =
  | "requested"
  | "provisioning"
  | "ready"
  | "waking"
  | "hibernating"
  | "deleting"
  | "deleted"
  | "error";

/**
 * Which runtime a computer boots. Hand-mirrored from the backend
 * (`projectComputers.runtimeKind`, PR d/e2); absent ⇒ terminal, so every
 * existing caller keeps the terminal behaviour it had before desktop existed.
 */
export type RuntimeKind = "terminal" | "desktop-browser";

export interface ReservedComputer {
  computerId: string;
  status: ComputerStatus;
  provider: string;
  lastError?: string;
}

export interface ComputerSandboxInfo {
  computerId: string;
  providerComputerId: string | null;
  provider: string;
  status: ComputerStatus;
  projectId: string;
  ownerUserId: string;
  /** Hand-mirrored from the backend `ComputerView` (PR e2). */
  runtimeKind?: RuntimeKind;
  bootedRuntimeCapabilities?: string[];
}

export type ControlPlaneResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

export function getConvexHttpUrl(): string | null {
  return process.env.CONVEX_HTTP_URL?.trim() || null;
}

/**
 * Set once the boot bootstrap gets a 401 from this server's Convex
 * (`runtime-config.ts` calls `markServiceTokenRejected`): the
 * `INSPECTOR_SERVICE_TOKEN` this process holds is NOT a valid data-plane
 * credential. The runtime-config route and every secret-gated `/computers/*`
 * route gate on the SAME check, so a token the bootstrap rejected will also
 * 401 the data-plane calls — it must not count toward
 * `isComputersDataPlaneConfigured()` or be presented on requests, or the
 * server would advertise `localConfigured: true` while every computer call
 * hard-401s. Sticky for the process lifetime: a wrong token only becomes
 * right via an env change + restart, and a 401 bootstrap never re-runs.
 */
let serviceTokenRejected = false;

/** Called by the bootstrap on a 401. */
export function markServiceTokenRejected(): void {
  serviceTokenRejected = true;
}

export function resetServiceTokenRejectedForTests(): void {
  serviceTokenRejected = false;
}

function getServiceToken(): string | null {
  if (serviceTokenRejected) return null;
  return process.env.INSPECTOR_SERVICE_TOKEN?.trim() || null;
}

/**
 * True when everything the computers data plane needs is present: a Convex to
 * talk to, the inspector service token, the vendor key, and the terminal-token
 * secret. The secret is still required because it signs/verifies harness proxy
 * tokens (`harness-proxy-token.ts`) even though terminal tokens are now
 * RS256/JWKS.
 *
 * Values may arrive from the environment OR from the boot bootstrap
 * (`runtime-config.ts`, which fills env in place) — callers that can run
 * before startup finishes must await `initComputersRuntimeConfigBootstrap`
 * first (see `initComputersStartup` in `remote-data-plane.ts`).
 */
export function isComputersDataPlaneConfigured(): boolean {
  return Boolean(
    getConvexHttpUrl() &&
      getServiceToken() &&
      process.env.E2B_API_KEY &&
      process.env.COMPUTERS_TERMINAL_TOKEN_SECRET?.trim()
  );
}

async function postJson<T>(
  path: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ControlPlaneResult<T>> {
  const base = getConvexHttpUrl();
  if (!base) {
    return { ok: false, status: 0, error: "CONVEX_HTTP_URL is not set" };
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, base).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    logger.error(`[computers] ${path} network error`, err);
    return { ok: false, status: 0, error: "network error" };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // fall through with null payload
  }
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `request failed (${response.status})`;
    return { ok: false, status: response.status, error };
  }
  return { ok: true, value: payload as T };
}

/**
 * Server-to-server auth headers for the secret-gated `/computers/*` routes:
 * the inspector service token. Null when the server holds no (valid) token —
 * callers treat that as unconfigured.
 */
function authHeaders(): Record<string, string> | null {
  const token = getServiceToken();
  return token ? { "x-inspector-service-token": token } : null;
}

function bearerHeader(raw: string): Record<string, string> {
  const value = raw.trim();
  return {
    authorization: /^bearer\s/i.test(value) ? value : `Bearer ${value}`,
  };
}

export interface EvalSandbox {
  sandboxId: string;
  sandboxRowId: string;
}

/**
 * Provision a fresh ephemeral sandbox for one eval iteration, pinned to the
 * run's frozen environment build (user-bearer auth). The body carries only the
 * run/iteration ids — the control plane resolves the image from the run's
 * configSnapshot, so this can never boot an arbitrary template.
 */
export async function provisionEvalSandbox(args: {
  bearer: string;
  runId: string;
  iterationId?: string;
  signal?: AbortSignal;
}): Promise<ControlPlaneResult<EvalSandbox>> {
  return postJson<EvalSandbox>(
    "/evals/sandbox/provision",
    bearerHeader(args.bearer),
    {
      runId: args.runId,
      ...(args.iterationId ? { iterationId: args.iterationId } : {}),
    },
    args.signal
  );
}

export interface ResolvedEvalAttachment {
  name: string;
  /** Absolute path inside the sandbox to write the file to (frozen at run start). */
  path: string;
  contentHash: string;
  size: number;
  /** Short-lived download URL for the pinned blob; null when the pin is gone. */
  url: string | null;
}

export interface ResolvedEvalAttachmentsCase {
  /** Frozen case id — match against the running iteration's `test.testCaseId`. */
  testCaseId: string;
  attachments: ResolvedEvalAttachment[];
}

/**
 * Resolve the run's frozen per-case attachments to download URLs (user-bearer
 * auth). The control plane joins each case's pinned content-hashes to their
 * blobs and mints short-lived URLs; a `url: null` means the pin vanished, and
 * the caller must fail the iteration honestly rather than seed a missing file.
 */
export async function resolveEvalRunAttachments(args: {
  bearer: string;
  runId: string;
  signal?: AbortSignal;
}): Promise<ControlPlaneResult<{ cases: ResolvedEvalAttachmentsCase[] }>> {
  return postJson<{ cases: ResolvedEvalAttachmentsCase[] }>(
    "/evals/sandbox/attachments",
    bearerHeader(args.bearer),
    { runId: args.runId },
    args.signal
  );
}

export interface JourneySandbox {
  sandboxId: string;
  sandboxRowId: string;
  /** Working directory the target's host configured (backend-resolved). */
  workdir?: string;
}

/**
 * Provision (or re-obtain) the ephemeral sandbox for ONE journey attempt —
 * user-bearer auth, the launching member's token.
 *
 * The body carries only `(runId, targetId, sessionIdx)`. The control plane
 * resolves the image from the run's frozen snapshot and the vendor template
 * from the frozen build, so this can never boot an arbitrary template — the
 * caller does not know, and cannot supply, an image identifier.
 *
 * IDEMPOTENT at the backend: a duplicated call for the same attempt returns the
 * same sandbox rather than booting a second paid box, and a call arriving after
 * the attempt finished is refused outright.
 *
 * Failure statuses the caller must distinguish:
 *   409 — no image pinned / attempt not running / image unavailable. Terminal
 *         for this attempt; retrying cannot help.
 *   503 — at capacity. Retryable with backoff.
 */
export async function provisionJourneySandbox(args: {
  bearer: string;
  runId: string;
  targetId: string;
  sessionIdx: number;
  signal?: AbortSignal;
}): Promise<ControlPlaneResult<JourneySandbox>> {
  return postJson<JourneySandbox>(
    "/journeys/sandbox/provision",
    bearerHeader(args.bearer),
    {
      runId: args.runId,
      targetId: args.targetId,
      sessionIdx: args.sessionIdx,
    },
    args.signal
  );
}

/**
 * A one-time, user-visible fact about a scenario conversation's sandbox —
 * the BACKEND-mintable subset of `SandboxNoticeReason`. Inspector-minted
 * reasons (`sandbox_unavailable`) are deliberately NOT members: there is no
 * backend notice row behind them, so they must never enter the ack protocol.
 */
export type ScenarioSandboxNotice = "sandbox_reset" | "stale_image";

const SCENARIO_SANDBOX_NOTICES: ReadonlySet<string> = new Set([
  "sandbox_reset",
  "stale_image",
]);

export function isScenarioSandboxNotice(
  value: unknown
): value is ScenarioSandboxNotice {
  return typeof value === "string" && SCENARIO_SANDBOX_NOTICES.has(value);
}

/**
 * The notice peek/ack protocol version this build speaks (mcpjam-backend
 * `scenarioSandboxes.SCENARIO_SANDBOX_NOTICE_ACK_VERSION`).
 *
 * Declaring it switches the backend from "consume at provision" to "return
 * pending, wait for an ack". It is a CLIENT flag on purpose: an unacked notice
 * re-delivers on the next peek, so a build that cannot ack must never be put
 * into peek mode or it would re-show "your sandbox was reset" every turn.
 * A backend that predates the protocol ignores the field and consumes as
 * before, which its `noticeAckPending: false` reports back.
 */
export const SCENARIO_SANDBOX_NOTICE_ACK_VERSION = 1;

export interface ScenarioSandbox {
  sandboxId: string;
  sandboxRowId: string;
  /** Working directory the environment's host configured (backend-resolved). */
  workdir?: string;
  /**
   * Notices to surface for this conversation. Emit every one of them.
   *
   * Whether they are already consumed depends on {@link noticeAckPending}.
   */
  notices?: ScenarioSandboxNotice[];
  /**
   * TRUE ⇒ these notices are still PENDING server-side and this caller MUST
   * {@link ackScenarioSandboxNotices} once they are on the wire, or they will be
   * re-delivered on the next turn.
   *
   * FALSE/absent ⇒ already consumed by the provision call — either the legacy
   * fused path or a backend that predates the protocol. Nothing to ack.
   */
  noticeAckPending?: boolean;
}

/**
 * Provision (or re-obtain) the ephemeral sandbox for ONE scenario conversation —
 * user-bearer auth, the acting member's token.
 *
 * The body carries only `(scenarioId, chatSessionId)`. The control plane resolves
 * the image from the environment the scenario points at, LIVE, on every call, so
 * this can never boot an arbitrary template — the caller does not know, and
 * cannot supply, an image identifier.
 *
 * IDEMPOTENT at the backend: the next turn of the same conversation returns the
 * SAME sandbox rather than booting a second paid box. There is no matching
 * release: the box lives for the conversation and the backend's idle reaper
 * (20 min since last use, 4h ceiling) owns its teardown.
 *
 * Failure statuses the caller must distinguish:
 *   409 — not env-backed / no image pinned / image unavailable. Terminal for
 *         this conversation right now; retrying cannot help. Run WITHOUT bash.
 *   503 — at capacity, or a sibling call is still booting. Retryable.
 */
export async function provisionScenarioSandbox(args: {
  bearer: string;
  scenarioId: string;
  chatSessionId: string;
  signal?: AbortSignal;
}): Promise<ControlPlaneResult<ScenarioSandbox>> {
  return postJson<ScenarioSandbox>(
    "/scenarios/sandbox/provision",
    bearerHeader(args.bearer),
    {
      scenarioId: args.scenarioId,
      chatSessionId: args.chatSessionId,
      // Opt into peek/ack delivery. Without this the backend consumes the
      // notice here, before any SSE writer exists to carry it.
      noticeAckVersion: SCENARIO_SANDBOX_NOTICE_ACK_VERSION,
    },
    args.signal
  );
}

/**
 * ACK the notices this turn has PUT ON THE WIRE — the second half of the
 * peek/ack handshake.
 *
 * Call it immediately after writing the SSE parts, never before: the whole
 * point of the split is that the control plane does not mark a notice delivered
 * until it demonstrably was. A failed ack is therefore SAFE and deliberately
 * best-effort — the notice stays pending and is re-delivered next turn, which
 * is the correct direction to fail for "your sandbox was reset, earlier files
 * are gone".
 *
 * Idempotent at the backend: a duplicate ack consumes nothing.
 */
export async function ackScenarioSandboxNotices(args: {
  bearer: string;
  sandboxRowId: string;
  notices: ScenarioSandboxNotice[];
  signal?: AbortSignal;
}): Promise<void> {
  if (args.notices.length === 0) return;
  const result = await postJson(
    "/scenarios/sandbox/notices/ack",
    bearerHeader(args.bearer),
    { sandboxRowId: args.sandboxRowId, notices: args.notices },
    args.signal
  );
  if (!result.ok) {
    // Best-effort by design: re-delivery is the failure mode, not loss.
    logger.warn("[computers] failed to ack scenario sandbox notices", {
      sandboxRowId: args.sandboxRowId,
      status: result.status,
      error: result.error,
    });
  }
}

/**
 * Release ANY ephemeral sandbox (service-token auth; idempotent).
 *
 * Scope-agnostic: eval iterations and swarm attempts release through the same
 * route. Falls back to the legacy `/evals/sandbox/release` path when the
 * backend predates the rename — a server that can provision but cannot release
 * burns paid boxes until the GC cron notices them, so the fallback is not
 * cosmetic.
 */
export async function releaseSandbox(args: {
  sandboxRowId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const headers = authHeaders();
  if (!headers) return;
  let result = await postJson(
    "/computers/sandbox/release",
    headers,
    { sandboxRowId: args.sandboxRowId },
    args.signal
  );
  if (!result.ok && result.status === 404) {
    result = await postJson(
      "/evals/sandbox/release",
      headers,
      { sandboxRowId: args.sandboxRowId },
      args.signal
    );
  }
  if (!result.ok) {
    // Best-effort: the GC cron reaps any box this misses by TTL.
    logger.warn("[computers] failed to release ephemeral sandbox", {
      sandboxRowId: args.sandboxRowId,
      status: result.status,
      error: result.error,
    });
  }
}

/** @deprecated Renamed {@link releaseSandbox} — release is scope-agnostic now.
 * Kept so `evals-runner.ts` needs no edit. */
export async function releaseEvalSandbox(args: {
  sandboxRowId: string;
  signal?: AbortSignal;
}): Promise<void> {
  return releaseSandbox(args);
}

/**
 * Reserve/wake the acting user's computer (user-bearer auth). Phase 3: when an
 * `executionScope` is supplied (from runtime-config), send it so the backend
 * re-resolves live access and applies per-swarm isolation/caps; otherwise fall
 * back to the legacy `{ projectId }` body. The scope is opaque to the client —
 * the backend is authoritative.
 */
export async function reserveComputer(args: {
  bearer: string;
  projectId: string;
  executionScope?: ExecutionScope;
  /** Request a specific runtime (PR e2 forwards this at the reserve boundary).
   *  Absent ⇒ terminal, so existing callers are byte-for-byte unchanged. */
  runtimeKind?: RuntimeKind;
  signal?: AbortSignal;
}): Promise<ControlPlaneResult<ReservedComputer>> {
  const body: Record<string, unknown> = args.executionScope
    ? { executionScope: args.executionScope }
    : { projectId: args.projectId };
  if (args.runtimeKind) body.runtimeKind = args.runtimeKind;
  return postJson<ReservedComputer>(
    "/computers/reserve",
    bearerHeader(args.bearer),
    body,
    args.signal
  );
}

/** Exchange a computer row id for its vendor sandbox info (service-token auth). */
export async function getComputerSandboxInfo(args: {
  computerId: string;
  signal?: AbortSignal;
}): Promise<ControlPlaneResult<ComputerSandboxInfo>> {
  const headers = authHeaders();
  if (!headers) {
    // authHeaders() is null when the token is unset OR was rejected by the
    // bootstrap (markServiceTokenRejected) — name both so operators don't
    // chase a "not set" that is actually a wrong token.
    return {
      ok: false,
      status: 0,
      error: "INSPECTOR_SERVICE_TOKEN is not set or was rejected",
    };
  }
  return postJson<ComputerSandboxInfo>(
    "/computers/sandbox-info",
    headers,
    { computerId: args.computerId },
    args.signal
  );
}

/** Record an executed command (service-token auth; idempotent on commandId). */
export async function recordComputerCommand(args: {
  computerId: string;
  commandId: string;
  source: "chat" | "terminal-api";
  command: string;
  status: "completed" | "failed";
  exitCode?: number;
  outputPreview?: string;
}): Promise<void> {
  const headers = authHeaders();
  if (!headers) return;
  const result = await postJson("/computers/commands", headers, { ...args });
  if (!result.ok) {
    // Best-effort log write: the command already ran; losing the record must
    // not fail the tool call.
    logger.warn("[computers] failed to record command", {
      computerId: args.computerId,
      status: result.status,
      error: result.error,
    });
  }
}

export interface UploadBytesReservation {
  total: number;
  cap: number;
}

/**
 * Reserve `bytes` against the computer's cumulative-upload quota BEFORE writing
 * them into the box (service-token auth). The check-and-increment is atomic in
 * Convex, so this is the race-safe chokepoint shared by every metered file-API
 * writer (the `/computers/upload` route and harness skill-file materialization).
 * Callers MUST write only on `{ ok: true }`:
 *   - ok:true              → reserved; proceed with the write.
 *   - ok:false, status 413 → over quota; surface a 413-style error, write nothing.
 *   - ok:false, status 404 → computer gone; treat as unavailable (503).
 *   - ok:false, status 0   → not configured / network error; caller decides its
 *                            fail-open vs fail-closed policy.
 * Not idempotent — one successful call reserves the bytes exactly once, so call
 * it once per write with the total byte count.
 */
export async function reserveUploadBytes(args: {
  computerId: string;
  bytes: number;
  signal?: AbortSignal;
}): Promise<ControlPlaneResult<UploadBytesReservation>> {
  const headers = authHeaders();
  if (!headers) {
    return {
      ok: false,
      status: 0,
      error: "INSPECTOR_SERVICE_TOKEN is not set or was rejected",
    };
  }
  return postJson<UploadBytesReservation>(
    "/computers/reserve-upload-bytes",
    headers,
    { computerId: args.computerId, bytes: args.bytes },
    args.signal
  );
}

/** Record a terminal session transition (service-token auth; idempotent). */
export async function recordTerminalSession(args: {
  sessionId: string;
  action: "open" | "close";
  computerId?: string;
}): Promise<void> {
  const headers = authHeaders();
  if (!headers) return;
  const result = await postJson("/computers/terminal-sessions", headers, {
    sessionId: args.sessionId,
    action: args.action,
    ...(args.computerId ? { computerId: args.computerId } : {}),
  });
  if (!result.ok) {
    logger.warn("[computers] failed to record terminal session", {
      sessionId: args.sessionId,
      action: args.action,
      status: result.status,
      error: result.error,
    });
  }
}

/**
 * Bump the computer's `lastActiveAt` (service-token auth) so live terminal I/O
 * counts as activity for the idle-hibernate sweep. Sent throttled (~once/min)
 * from the terminal bridge on PTY I/O; best-effort — a dropped touch just risks
 * an earlier idle hibernate, never a failed keystroke.
 */
export async function touchComputerActivity(args: {
  computerId: string;
}): Promise<void> {
  const headers = authHeaders();
  if (!headers) return;
  const result = await postJson("/computers/terminal-sessions", headers, {
    action: "touch",
    computerId: args.computerId,
  });
  if (!result.ok) {
    logger.warn("[computers] failed to touch computer activity", {
      computerId: args.computerId,
      status: result.status,
      error: result.error,
    });
  }
}

/**
 * Reserve and poll until the computer is `ready` (provision-on-first-use and
 * wake-on-cold both converge here). Polling re-calls reserve — it's
 * idempotent, keeps `lastActiveAt` fresh so the idle sweep can't reclaim the
 * machine mid-wait, and rides the same authorization as the first call.
 */
export async function ensureComputerReady(args: {
  bearer: string;
  projectId: string;
  /** Phase 3 scope; forwarded verbatim to reserveComputer (legacy when absent). */
  executionScope?: ExecutionScope;
  /** Forwarded to reserveComputer on every poll so the desktop kind sticks. */
  runtimeKind?: RuntimeKind;
  signal?: AbortSignal;
  /** Overall budget. E2B cold provision is seconds; waking ~1s. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<ControlPlaneResult<ReservedComputer>> {
  const timeoutMs = args.timeoutMs ?? 75_000;
  const pollIntervalMs = args.pollIntervalMs ?? 1_500;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const reserved = await reserveComputer(args);
    if (!reserved.ok) return reserved;
    const { status } = reserved.value;
    if (status === "ready") return reserved;
    if (status === "error") {
      return {
        ok: false,
        status: 502,
        error: reserved.value.lastError
          ? `computer failed to provision: ${reserved.value.lastError}`
          : "computer failed to provision",
      };
    }
    if (status === "deleting" || status === "deleted") {
      return { ok: false, status: 410, error: "computer was deleted" };
    }
    if (Date.now() + pollIntervalMs > deadline) {
      return {
        ok: false,
        status: 504,
        error: `computer not ready after ${Math.round(
          timeoutMs / 1000
        )}s (status: ${status})`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    if (args.signal?.aborted) {
      return { ok: false, status: 499, error: "cancelled" };
    }
  }
}
