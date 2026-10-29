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
export async function runningSandboxConnection(
  sandboxId: string,
  options: SandboxApiOpts = {},
): Promise<ConstructorParameters<typeof Sandbox>[0]> {
  const deadline = Date.now() + 60_000;
  const timeout = AbortSignal.timeout(60_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
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
  await requireReadyPolicy(sandboxId, signal, deadline);
  return {
    ...options,
    sandboxId,
    sandboxDomain: data.domain ?? undefined,
    envdVersion: data.envdVersion,
    envdAccessToken: data.envdAccessToken,
  };
}

export async function attachRunningSandbox(
  sandboxId: string,
  options?: SandboxApiOpts,
): Promise<Sandbox> {
  return new Sandbox(await runningSandboxConnection(sandboxId, options));
}
