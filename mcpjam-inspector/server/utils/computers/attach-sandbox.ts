import { setTimeout as delay } from "node:timers/promises";
import {
  ApiClient,
  ConnectionConfig,
  Sandbox,
  SandboxNotFoundError,
  type SandboxApiOpts,
} from "e2b";
import {
  getSandboxEgressStatus,
  getSandboxTrafficToken,
  prepareSandboxConnection,
} from "./control-plane-client.js";

/** The control plane owns all wakes; attachment must not create a late wake. */
export class SandboxAttachmentError extends Error {
  constructor(
    public readonly code:
      | "sandbox_policy_unavailable"
      | "sandbox_asleep"
      | "sandbox_attach_failed",
    message: string,
  ) {
    super(message);
    this.name = "SandboxAttachmentError";
  }
}

/**
 * A box created with public traffic off refuses every non-envd request that
 * lacks its traffic access token: the harness bridge and the workspace
 * preview would both be turned away at the edge without it.
 */
async function readTrafficAccessToken(
  sandboxId: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await getSandboxTrafficToken({
    providerComputerId: sandboxId,
    signal,
  });
  if (!result.ok && result.status === 404)
    throw new SandboxNotFoundError("This sandbox no longer exists.");
  if (!result.ok || !result.value.trafficAccessToken)
    throw new SandboxAttachmentError(
      "sandbox_attach_failed",
      "Could not attach to this sandbox. Try again.",
    );
  return result.value.trafficAccessToken;
}

async function requireReadyPolicy(
  sandboxId: string,
  signal: AbortSignal,
  deadline: number,
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const result = await getSandboxEgressStatus({
      providerComputerId: sandboxId,
      signal,
    });
    if (!result.ok)
      throw new SandboxAttachmentError(
        "sandbox_policy_unavailable",
        "Could not check this sandbox. Try again.",
      );
    if (result.value.ok === true) return;
    if (result.value.reason !== "egress_busy")
      throw new SandboxAttachmentError(
        "sandbox_policy_unavailable",
        "This sandbox cannot run safely. Start a new sandbox.",
      );
    const remaining = Math.min(deadline, result.value.deadline) - Date.now();
    if (!(remaining > 0))
      throw new SandboxAttachmentError(
        "sandbox_policy_unavailable",
        "Sandbox network settings are still being updated. Try again shortly.",
      );
    await delay(Math.min(250, remaining), undefined, { signal });
  }
}

/** Pick only connection fields. The GET response can also contain secret-bearing network rules. */
async function readRunningSandboxConnection(
  sandboxId: string,
  options: SandboxApiOpts,
  preparedByBroker: boolean,
): Promise<ConstructorParameters<typeof Sandbox>[0]> {
  const deadline = Date.now() + 60_000;
  const timeout = AbortSignal.timeout(60_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  signal.throwIfAborted();
  if (!preparedByBroker) {
    await requireReadyPolicy(sandboxId, signal, deadline);
    const prepared = await prepareSandboxConnection({
      providerComputerId: sandboxId,
      signal,
    });
    if (
      !prepared.ok &&
      prepared.status === 404 &&
      prepared.code === "sandbox_not_found"
    )
      throw new SandboxNotFoundError("This sandbox no longer exists.");
    if (!prepared.ok || prepared.value.ok !== true)
      throw new SandboxAttachmentError(
        "sandbox_policy_unavailable",
        "Could not prepare this sandbox. Try again.",
      );
  }
  const config = new ConnectionConfig(options);
  const response = await new ApiClient(config).api.GET(
    "/sandboxes/{sandboxID}",
    {
      params: { path: { sandboxID: sandboxId } },
      signal: config.getSignal(options.requestTimeoutMs, signal),
    },
  );
  if (response.response.status === 404)
    throw new SandboxNotFoundError("This sandbox no longer exists.");
  const data = response.data;
  if (
    !response.response.ok ||
    !data ||
    data.sandboxID !== sandboxId ||
    !data.envdAccessToken
  )
    throw new SandboxAttachmentError(
      "sandbox_attach_failed",
      "Could not attach to this sandbox. Try again.",
    );
  if (data.state !== "running")
    throw new SandboxAttachmentError(
      "sandbox_asleep",
      "This sandbox is paused. Wake it through MCPJam and try again.",
    );
  if (data.lifecycle?.autoResume !== false)
    throw new SandboxAttachmentError(
      "sandbox_policy_unavailable",
      "This sandbox cannot run safely. Start a new sandbox.",
    );
  const trafficAccessToken =
    data.network?.allowPublicTraffic === false
      ? await readTrafficAccessToken(sandboxId, signal)
      : undefined;
  await requireReadyPolicy(sandboxId, signal, deadline);
  return {
    ...options,
    sandboxId,
    sandboxDomain: data.domain ?? undefined,
    envdVersion: data.envdVersion,
    envdAccessToken: data.envdAccessToken,
    ...(trafficAccessToken ? { trafficAccessToken } : {}),
  };
}

export async function attachRunningSandbox(
  sandboxId: string,
  options?: SandboxApiOpts,
): Promise<Sandbox> {
  return new Sandbox(await runningSandboxConnection(sandboxId, options));
}

/** Ordinary callers retain the wake/renewal and both readiness barriers. */
export function runningSandboxConnection(
  sandboxId: string,
  options: SandboxApiOpts = {},
): Promise<ConstructorParameters<typeof Sandbox>[0]> {
  return readRunningSandboxConnection(sandboxId, options, false);
}

/**
 * Only after the broker acknowledged its wake and network-policy install for
 * this box. GET still verifies lifecycle state, and the final live readiness
 * barrier refuses quarantine or waits for a concurrent policy writer.
 */
export async function attachBrokerPreparedSandbox(
  sandboxId: string,
  options: SandboxApiOpts = {},
): Promise<Sandbox> {
  return new Sandbox(
    await readRunningSandboxConnection(sandboxId, options, true),
  );
}
