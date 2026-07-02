/**
 * Resolve the acting user's host **computer** to a live E2B sandbox id for the
 * Claude Code harness to attach to.
 *
 * Mirrors the bash-tool / terminal data-plane path exactly
 * (`server/utils/computers/*`): the inspector server is the data plane, Convex
 * is the control plane.
 *
 *   1. `ensureComputerReady` (user-bearer auth) — provision-on-first-use and
 *      wake-on-cold both converge here, polling until `ready`. This is the wake
 *      step the harness needs: `Sandbox.connect` will NOT resume a hibernated
 *      box, so the control plane must wake it first. Each poll also refreshes
 *      `lastActiveAt`, so the idle-hibernate sweep can't reclaim the machine
 *      mid-run.
 *   2. `getComputerSandboxInfo` (shared-secret auth) — exchange the Convex row
 *      id for the vendor sandbox id (`providerComputerId`). Secret-gated; the
 *      browser never sees vendor ids.
 */
import {
  ensureComputerReady,
  getComputerSandboxInfo,
  isComputersDataPlaneConfigured,
} from "../computers/control-plane-client.js";

/** Resolution failure carrying an HTTP-ish status for the caller to surface. */
export class HarnessSandboxResolutionError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HarnessSandboxResolutionError";
    this.status = status;
  }
}

export interface ResolvedHarnessSandbox {
  /** Convex computer row id (control-plane identity). */
  computerId: string;
  /** E2B sandbox id (vendor identity) to `Sandbox.connect` to. */
  sandboxId: string;
}

export async function resolveHarnessSandbox(args: {
  /** The acting user's bearer (forwarded to the control plane for authz). */
  bearer: string;
  projectId: string;
  signal?: AbortSignal;
  /** Overall budget for provision/wake polling (default in control plane). */
  timeoutMs?: number;
}): Promise<ResolvedHarnessSandbox> {
  if (!isComputersDataPlaneConfigured()) {
    throw new HarnessSandboxResolutionError(
      "computers data plane is not configured (need CONVEX_HTTP_URL, " +
        "COMPUTERS_DATA_PLANE_SECRET, and E2B_API_KEY)",
      503,
    );
  }

  const ready = await ensureComputerReady({
    bearer: args.bearer,
    projectId: args.projectId,
    signal: args.signal,
    timeoutMs: args.timeoutMs,
  });
  if (!ready.ok) {
    throw new HarnessSandboxResolutionError(ready.error, ready.status);
  }

  const info = await getComputerSandboxInfo({
    computerId: ready.value.computerId,
    signal: args.signal,
  });
  if (!info.ok) {
    throw new HarnessSandboxResolutionError(info.error, info.status);
  }

  const sandboxId = info.value.providerComputerId;
  if (!sandboxId) {
    // `ready` above means the control plane reports the box ready, but the
    // vendor id can still be momentarily absent — treat as retryable.
    throw new HarnessSandboxResolutionError(
      `computer ${ready.value.computerId} has no provider sandbox id yet ` +
        `(status: ${info.value.status})`,
      503,
    );
  }

  return { computerId: ready.value.computerId, sandboxId };
}
