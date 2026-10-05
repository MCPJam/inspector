/**
 * An ephemeral box's VENDOR lifecycle, as the control plane resolved it — and
 * the typed failure for "that box is gone".
 *
 * Eval / journey / scenario boxes are created with a per-scope KILL window
 * (mcpjam-backend `lib/ephemeralSandboxes.resolveScopeVendorLifecycle`): E2B
 * destroys the box when the window lapses, and the backend renews it while the
 * box's work is still alive. `Sandbox.connect` arms a window too — with the
 * SDK's own default when none is passed — so a data-plane connect has to arm
 * the box's OWN window, never whatever the SDK happens to default to.
 *
 * The provision routes return the policy beside the vendor id
 * (`vendorLifecycle`). Absent ⇒ a backend that predates it; the caller then
 * connects exactly as before.
 */

import { HarnessInfraSetupError } from "../harness/harness-provider-error.js";

/** The server-resolved policy, as the provision routes return it. */
export interface SandboxVendorLifecycle {
  onTimeout: "pause" | "kill";
  /** The window a connect may arm, in seconds. Absent ⇒ provider default. */
  timeoutSeconds?: number;
  /**
   * Epoch ms no connect may arm a window past (e.g. a scenario box's 4h
   * ceiling). Absent ⇒ no ceiling beyond the window itself.
   */
  deadlineAt?: number;
}

/**
 * Narrow the `vendorLifecycle` field off a provision response. Anything
 * malformed reads as absent — the pre-policy connect — rather than as a
 * window this process invented.
 */
export function parseSandboxVendorLifecycle(
  raw: unknown,
): SandboxVendorLifecycle | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (value.onTimeout !== "pause" && value.onTimeout !== "kill") {
    return undefined;
  }
  const finite = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  return {
    onTimeout: value.onTimeout,
    ...(finite(value.timeoutSeconds)
      ? { timeoutSeconds: value.timeoutSeconds }
      : {}),
    ...(finite(value.deadlineAt) ? { deadlineAt: value.deadlineAt } : {}),
  };
}

/**
 * `{ vendorLifecycle }` when the provision response carried a usable one, `{}`
 * otherwise — for spreading into a harness binding.
 */
export function vendorLifecycleField(raw: unknown): {
  vendorLifecycle?: SandboxVendorLifecycle;
} {
  const vendorLifecycle = parseSandboxVendorLifecycle(raw);
  return vendorLifecycle ? { vendorLifecycle } : {};
}

/**
 * Less than this left before the ceiling ⇒ the box takes no new work. Matches
 * the control plane's own admission margin.
 */
export const SANDBOX_CONNECT_MARGIN_MS = 3 * 60_000;

/**
 * The `timeoutMs` a `Sandbox.connect` to this box should pass.
 *
 *   - no policy (older backend, personal computer) → `undefined`, the
 *     historical connect;
 *   - a policy window → that window, capped so it never runs past the
 *     ceiling. E2B only ever LENGTHENS a running box's window on connect, so
 *     this cannot cut a renewed box short;
 *   - inside the margin of the ceiling → `expired`: the caller must refuse the
 *     work, typed, rather than start it on a box about to be destroyed.
 */
export function resolveSandboxConnectTimeoutMs(
  lifecycle: SandboxVendorLifecycle | undefined,
  nowMs: number,
): { ok: true; timeoutMs?: number } | { ok: false; reason: "expired" } {
  if (!lifecycle || lifecycle.timeoutSeconds === undefined) return { ok: true };
  const windowMs = lifecycle.timeoutSeconds * 1000;
  if (lifecycle.deadlineAt === undefined)
    return { ok: true, timeoutMs: windowMs };
  const remainingMs = lifecycle.deadlineAt - nowMs;
  if (remainingMs < SANDBOX_CONNECT_MARGIN_MS) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, timeoutMs: Math.min(windowMs, remainingMs) };
}

export type SandboxUnavailableCode = "sandbox_not_found" | "sandbox_expiring";

/**
 * The box behind this turn is GONE (`sandbox_not_found`, vendor 404 — killed
 * on its timeout, or deleted) or too close to its ceiling to take new work
 * (`sandbox_expiring`).
 *
 * A SANDBOX-layer infrastructure failure: it says nothing about the server
 * under test, it is not retryable into the same box, and reconnecting into a
 * fresh box as though the attempt survived would be wrong.
 *
 * A {@link HarnessInfraSetupError}, so the structured evidence
 * (`harnessFailure: {layer: "sandbox", code, httpStatus?, isRetryable: false}`)
 * reaches the infra-error classifier through `harnessFailureEvidenceOf` with
 * no message parsing. `phase` and `sandboxId` are diagnostics on top.
 */
export class SandboxUnavailableError extends HarnessInfraSetupError {
  readonly code: SandboxUnavailableCode;
  /** Where it surfaced: the data-plane connect, or the broker's wake. */
  readonly phase: "connect" | "broker";
  readonly httpStatus?: number;
  readonly sandboxId?: string;

  constructor(args: {
    code: SandboxUnavailableCode;
    phase: "connect" | "broker";
    httpStatus?: number;
    sandboxId?: string;
    message?: string;
    cause?: unknown;
  }) {
    super(
      args.message ??
        (args.code === "sandbox_not_found"
          ? "The sandbox for this turn no longer exists."
          : "The sandbox for this turn is about to expire and cannot take new work."),
      {
        layer: "sandbox",
        code: args.code,
        ...(args.httpStatus !== undefined
          ? { httpStatus: args.httpStatus }
          : {}),
        isRetryable: false,
      },
    );
    this.code = args.code;
    this.phase = args.phase;
    if (args.httpStatus !== undefined) this.httpStatus = args.httpStatus;
    if (args.sandboxId !== undefined) this.sandboxId = args.sandboxId;
    if (args.cause !== undefined) this.cause = args.cause;
  }
}

export function isSandboxUnavailableError(
  err: unknown,
): err is SandboxUnavailableError {
  return err instanceof SandboxUnavailableError;
}
