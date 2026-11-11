/**
 * The forwarding grant for a turn that takes no model lease.
 *
 * An external-account runtime runs on the customer's own key, so MCPJam mints
 * no model lease for it. Forwarding still needs the box grant the egress proxy
 * injects into each forwarded request; the backend installs that grant on its
 * own (`/web/harness/forwarding/start`), renews it with the box reservation's
 * heartbeat, and clears it with the revoke a lease uses.
 */
import { z } from "zod";
import { inspectorAiRequestHeaders } from "../../ai-request-headers.js";
import { logger } from "../../logger.js";
import { bearerHeader, getConvexHttpUrl } from "../harness-broker-http.js";
import {
  boxRequestFields,
  revokeHarnessModelBroker,
  type HarnessBrokerBox,
} from "../harness-model-broker.js";
import type { HarnessId } from "../registry.js";
import type { ForwardingOwner } from "./execution-control.js";
import {
  readNativeForwardingResult,
  type NativeForwardingSelection,
} from "./native-turn.js";

export type HarnessForwardingGrantResult =
  | {
      ok: true;
      expiresAt: number;
      forwarding: { owners: ForwardingOwner[]; origin: string };
    }
  | { ok: false; status: number; error: string; code?: string };

const started = z.object({
  ok: z.literal(true),
  runId: z.string().min(1),
  expiresAt: z.number().finite(),
  delivery: z.literal("e2b-network-transform"),
});
const refused = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
});
const UNAVAILABLE =
  "Couldn't set up MCP forwarding for this turn. Send your message again.";

/** An answer that is not JSON is as unusable as a refusal. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function startHarnessForwardingGrant(args: {
  box: HarnessBrokerBox;
  harnessId: HarnessId;
  modelId: string;
  /** The turn id, which is also the box reservation's run id. */
  runId: string;
  nativeForwarding: NativeForwardingSelection;
  bearer: string;
  signal?: AbortSignal;
}): Promise<HarnessForwardingGrantResult> {
  let response: Response;
  try {
    response = await fetch(
      new URL("/web/harness/forwarding/start", getConvexHttpUrl()),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...inspectorAiRequestHeaders("harness"),
          authorization: bearerHeader(args.bearer),
        },
        body: JSON.stringify({
          ...boxRequestFields(args.box),
          harnessId: args.harnessId,
          modelId: args.modelId,
          runId: args.runId,
          nativeForwarding: args.nativeForwarding,
        }),
        signal: args.signal,
      },
    );
  } catch (error) {
    logger.warn("[harness-forwarding] grant start failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return { ok: false, status: 502, error: UNAVAILABLE };
  }
  const payload = await readJson(response);
  const revoke = () =>
    revokeHarnessModelBroker({
      runId: args.runId,
      ...(args.box.kind === "computer" ? { projectId: args.box.projectId } : {}),
      bearer: args.bearer,
    });
  const grant = response.ok ? started.safeParse(payload) : undefined;
  if (!grant?.success || grant.data.runId !== args.runId) {
    // An answer this turn cannot read may still have installed a grant.
    if (response.ok) await revoke();
    const reason = refused.safeParse(payload);
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error: (reason.success && reason.data.error) || UNAVAILABLE,
      ...(!response.ok && reason.success && reason.data.code
        ? { code: reason.data.code }
        : {}),
    };
  }
  const forwarding = readNativeForwardingResult(payload, args.nativeForwarding);
  if (!forwarding) {
    // Installed, but not for the owners this turn asked for: clear it now.
    await revoke();
    return {
      ok: false,
      status: 502,
      error:
        "Couldn't confirm MCP forwarding for this turn. Send your message again.",
    };
  }
  return { ok: true, expiresAt: grant.data.expiresAt, forwarding };
}
