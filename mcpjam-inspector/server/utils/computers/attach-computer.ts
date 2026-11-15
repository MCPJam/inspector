import { setTimeout as delay } from "node:timers/promises";
import type { Sandbox } from "e2b";
import {
  getComputerSandboxInfo,
  wakeComputer,
  type ComputerSandboxInfo,
} from "./control-plane-client.js";
import {
  attachRunningSandbox,
  SandboxAttachmentError,
} from "./attach-sandbox.js";

/** Keep durable state/accounting in sync before attaching a terminal or upload. */
export async function attachComputerSandbox(
  expected: ComputerSandboxInfo,
  callerSignal?: AbortSignal,
): Promise<Sandbox> {
  if (!expected.computerId || !expected.providerComputerId)
    throw new SandboxAttachmentError(
      "sandbox_attach_failed",
      "This computer is unavailable.",
    );
  const timeout = AbortSignal.timeout(60_000);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeout])
    : timeout;
  signal.throwIfAborted();
  const waking = await wakeComputer({
    computerId: expected.computerId,
    signal,
  });
  if (!waking.ok)
    throw new SandboxAttachmentError(
      "sandbox_attach_failed",
      "Could not wake this computer. Try again.",
    );
  for (;;) {
    signal.throwIfAborted();
    const info = await getComputerSandboxInfo({
      computerId: expected.computerId,
      signal,
    });
    if (
      !info.ok ||
      info.value.providerComputerId !== expected.providerComputerId ||
      info.value.ownerUserId !== expected.ownerUserId ||
      info.value.projectId !== expected.projectId
    )
      throw new SandboxAttachmentError(
        "sandbox_attach_failed",
        "This computer is no longer available.",
      );
    if (info.value.status === "ready") {
      const sandbox = await attachRunningSandbox(expected.providerComputerId, {
        signal,
      });
      // Preparation may wait for a policy write; verify ownership again before use.
      const current = await getComputerSandboxInfo({
        computerId: expected.computerId,
        signal,
      });
      if (
        !current.ok ||
        current.value.providerComputerId !== expected.providerComputerId ||
        current.value.ownerUserId !== expected.ownerUserId ||
        current.value.projectId !== expected.projectId
      )
        throw new SandboxAttachmentError(
          "sandbox_attach_failed",
          "This computer is no longer available.",
        );
      return sandbox;
    }
    if (info.value.status !== "waking" && info.value.status !== "hibernating")
      throw new SandboxAttachmentError(
        "sandbox_attach_failed",
        "This computer is unavailable.",
      );
    await delay(250, undefined, { signal });
  }
}
