import type { Experimental_SandboxSession } from "@ai-sdk/provider-utils";
import {
  harnessSessionDataDirectoryPath,
  harnessStateDirectoryPath,
  type HarnessV1NetworkSandboxSession,
} from "@ai-sdk/harness";
import { resolveSandboxHomeDir } from "@ai-sdk/harness/utils";
import { reapHarnessBridgesCommand } from "./bridge-reaper.js";
import WebSocket from "ws";
import { z } from "zod";

const bridgeState = z.object({
  data: z.object({
    bridge: z.object({
      port: z.number().int().min(1).max(65535),
      token: z.string().min(1),
    }),
  }),
});

/** End the original bridge after suspension detached its framework handle. */
export async function destroySuspendedBridge(
  state: unknown,
  endpointFor: HarnessV1NetworkSandboxSession["getPortEndpoint"],
): Promise<void> {
  const { port, token } = bridgeState.parse(state).data.bridge;
  const endpoint = await endpointFor({ port, protocol: "ws" });
  const url = new URL(endpoint.url);
  url.searchParams.set("agent_bridge_token", token);
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: endpoint.headers });
    let sent = false;
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("The suspended harness bridge did not stop."));
    }, 5_000);
    socket.on("message", (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (
        !sent &&
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "bridge-hello"
      ) {
        sent = true;
        socket.send(JSON.stringify({ type: "destroy" }));
      }
    });
    socket.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not reach the suspended harness bridge."));
    });
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      if (sent && code === 1000 && reason.toString() === "destroy") resolve();
      else reject(new Error("The suspended harness bridge refused cleanup."));
    });
  });
}

/** Scope forced cleanup to this framework session and its child processes. */
export async function forceDestroySessionBridge(
  sessionId: string,
  sandbox: Experimental_SandboxSession,
): Promise<void> {
  const abortSignal = AbortSignal.timeout(10_000);
  const sandboxHomeDir = await resolveSandboxHomeDir({ sandbox, abortSignal });
  const directory = harnessSessionDataDirectoryPath({
    stateDirectory: harnessStateDirectoryPath({ sandboxHomeDir }),
    sessionId,
  });
  const result = await sandbox.run({
    command: reapHarnessBridgesCommand(`${directory}/bridge`, 1_000, true),
    abortSignal,
  });
  if (result.exitCode !== 0)
    throw new Error("Could not stop the session's harness processes.");
}
