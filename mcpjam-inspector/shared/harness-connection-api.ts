/**
 * The one question org-key admission asks of a connection: does it serve the
 * API this harness speaks? Admission asks this rather than compare the
 * connection's vendor with the harness's, because the API is what the runtime
 * puts on the wire. Mirrors the backend's `convex/lib/harnessConnectionApi.ts`.
 */
import type { Harness } from "@mcpjam/sdk/host-config/internal";
import type { GatewayApi } from "./gateway-connection";
import { HARNESS_DESCRIPTORS } from "./harness-descriptors";

/** The model APIs a harness speaks: Claude Code's and Codex's wire formats. */
export type HarnessWireApi = "anthropicMessages" | "responses";

/**
 * What admission reads of an organization connection: its provider key and,
 * for a gateway (`custom:*`), the APIs the visible org config says it serves.
 */
export type HarnessConnection = {
  providerKey: string;
  apis?: readonly GatewayApi[];
};

function descriptorOf(harnessId: string) {
  return Object.hasOwn(HARNESS_DESCRIPTORS, harnessId)
    ? HARNESS_DESCRIPTORS[harnessId as Harness]
    : undefined;
}

/** The API `harnessId` speaks to its model; `null` when it speaks none to us. */
export function harnessWireApi(harnessId: string): HarnessWireApi | null {
  switch (descriptorOf(harnessId)?.protocol) {
    case "anthropic-messages":
      return "anthropicMessages";
    case "openai-responses":
      return "responses";
    default:
      return null;
  }
}

/** Whether `harnessId` may run on an organization connection at all. */
export function harnessTakesOrgKeys(harnessId: string): boolean {
  return descriptorOf(harnessId)?.orgKeys ?? false;
}

/**
 * Whether an organization connection serves `api`. Anthropic serves Messages
 * and OpenAI serves Responses; a gateway (`custom:*`) serves the APIs its
 * admin turned on (`apis`). No other provider serves a harness API, and a
 * harness that speaks no API (`null`) is served by nothing.
 */
export function connectionServesHarnessApi(
  connection: HarnessConnection,
  api: HarnessWireApi | null,
): boolean {
  if (api === null) return false;
  if (connection.providerKey.startsWith("custom:")) {
    return connection.apis?.includes(api) ?? false;
  }
  switch (connection.providerKey) {
    case "anthropic":
      return api === "anthropicMessages";
    case "openai":
      return api === "responses";
    default:
      return false;
  }
}

/**
 * Whether `harnessId` can run on `connection`: the harness takes organization
 * keys, and the connection serves the API the harness speaks.
 */
export function harnessRunsOnConnection(
  harnessId: string,
  connection: HarnessConnection | undefined,
): boolean {
  return (
    connection !== undefined &&
    harnessTakesOrgKeys(harnessId) &&
    connectionServesHarnessApi(connection, harnessWireApi(harnessId))
  );
}
