/**
 * Node-safe `emptyHostConfigInputV2` builder + its return type.
 *
 * Ported verbatim from the inspector client's `emptyHostConfigInputV2`
 * (`client/src/lib/client-config-v2.ts`) so host-template seeding can run in
 * Node (the server's `--template` resolver) without importing browser-only
 * client modules. The client re-exports this function (cast to its strict
 * `HostConfigInputV2` type) so there is a single source of truth and the 80+
 * `@/lib/client-config-v2` importers don't churn.
 *
 * `SeededHostConfigInput` is the structural shape these seeds produce. It is
 * intentionally self-contained (no client type imports): the client casts it
 * to its strict editor aggregate; the server passes it straight to the Convex
 * `hosts:createHost` mutation, whose validator is the looser storage shape.
 */

import { DEFAULT_TEMPERATURE_V2 } from "../defaults.js";
import { getDefaultClientCapabilities } from "../../mcp-client-manager/capabilities.js";

/** Default host style for a brand-new config — MCPJam house chrome. */
export const DEFAULT_HOST_STYLE_V2 = "mcpjam";

/**
 * Mirror of the inspector client's `DEFAULT_REQUEST_TIMEOUT_MS`
 * (`client/src/lib/client-config.ts`). Relocated here so the SDK seed builder
 * has no client import.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

/**
 * Structural shape produced by `emptyHostConfigInputV2` and the host-template
 * seeds. Matches the client's strict `HostConfigInputV2` field-for-field, but
 * uses Node-safe primitive/record types so the SDK owns no client types.
 */
export type SeededHostConfigInput = {
  hostStyle: string;
  modelId: string;
  systemPrompt: string;
  temperature: number;
  requireToolApproval: boolean;
  respectToolVisibility: boolean;
  progressiveToolDiscovery?: boolean;
  serverIds: string[];
  optionalServerIds: string[];
  builtInToolIds: string[];
  computer?: { kind: "personal"; workdir?: string };
  // Real agent harness for this host. `"claude-code"` / `"codex"` run a real CLI
  // runtime (requires an attached computer); absent ⇒ MCPJam's emulated engine.
  // Kept as a local literal (mirrors the `Harness` union / HARNESS_IDS in
  // ../types.ts) so this module stays free of cross-imports.
  harness?: "claude-code" | "codex";
  connectionDefaults: {
    headers: Record<string, string>;
    requestTimeout: number;
  };
  clientCapabilities: Record<string, unknown>;
  hostContext: Record<string, unknown>;
  hostCapabilitiesOverride?: Record<string, unknown>;
  chatUiOverride?: Record<string, unknown>;
  mcpProfile?: Record<string, unknown>;
  serverConnectionOverrides?: Record<
    string,
    {
      headersOverride?: Record<string, string>;
      requestTimeoutOverride?: number;
      mcpProtocolVersionOverride?: string;
    }
  >;
};

function deepCloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepCloneJsonValue);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepCloneJsonValue(v);
    }
    return out;
  }
  return value;
}

function deepCloneJsonRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return deepCloneJsonValue(value) as Record<string, unknown>;
}

export function emptyHostConfigInputV2(
  partial: Partial<SeededHostConfigInput> = {},
): SeededHostConfigInput {
  // Clone every caller-provided array/record so the returned config can
  // be mutated freely without aliasing the input. Matches the cloning
  // behavior of hostConfigDtoToInput.
  return {
    hostStyle: partial.hostStyle ?? DEFAULT_HOST_STYLE_V2,
    modelId: partial.modelId ?? "",
    systemPrompt: partial.systemPrompt ?? "",
    temperature: partial.temperature ?? DEFAULT_TEMPERATURE_V2,
    requireToolApproval: partial.requireToolApproval ?? false,
    // Default ON: every new config respects SEP-1865 visibility filtering
    // unless the template (e.g. Cursor) explicitly opts out. Matches the
    // spec-default behavior.
    respectToolVisibility: partial.respectToolVisibility ?? true,
    // Brand-new inputs default to explicit Off. The orchestrator still
    // reads `undefined` as "auto policy" (existing rows surfaced by
    // `hostConfigDtoToInput` round-trip verbatim), but creating a fresh
    // host shouldn't silently opt into auto.
    progressiveToolDiscovery: partial.progressiveToolDiscovery ?? false,
    serverIds: partial.serverIds ? [...partial.serverIds] : [],
    optionalServerIds: partial.optionalServerIds
      ? [...partial.optionalServerIds]
      : [],
    builtInToolIds: partial.builtInToolIds ? [...partial.builtInToolIds] : [],
    computer: partial.computer
      ? {
          kind: "personal",
          ...(partial.computer.workdir
            ? { workdir: partial.computer.workdir }
            : {}),
        }
      : undefined,
    // String literal — near-pass-through like progressiveToolDiscovery.
    harness: partial.harness,
    connectionDefaults: {
      headers: partial.connectionDefaults?.headers
        ? { ...partial.connectionDefaults.headers }
        : {},
      requestTimeout:
        partial.connectionDefaults?.requestTimeout ??
        DEFAULT_REQUEST_TIMEOUT_MS,
    },
    // Seed with the SDK's default capabilities (which include the MCP UI
    // extension and any other built-ins) so a brand-new host config keeps
    // advertising them. An empty {} here would silently drop MCP Apps
    // support until the user manually edited the capability JSON.
    clientCapabilities: partial.clientCapabilities
      ? deepCloneJsonRecord(partial.clientCapabilities)
      : deepCloneJsonRecord(
          getDefaultClientCapabilities() as Record<string, unknown>,
        ),
    hostContext: partial.hostContext
      ? deepCloneJsonRecord(partial.hostContext)
      : {},
    hostCapabilitiesOverride: partial.hostCapabilitiesOverride
      ? deepCloneJsonRecord(partial.hostCapabilitiesOverride)
      : undefined,
    chatUiOverride: partial.chatUiOverride
      ? (deepCloneJsonValue(partial.chatUiOverride) as Record<string, unknown>)
      : undefined,
    // Backend distinguishes `undefined` (use SDK defaults) from
    // `{ profileVersion: 1 }` (empty envelope) on the hash, so a brand-new
    // input MUST stay undefined until the user opts in.
    mcpProfile: partial.mcpProfile
      ? (deepCloneJsonValue(partial.mcpProfile) as Record<string, unknown>)
      : undefined,
    serverConnectionOverrides: partial.serverConnectionOverrides
      ? Object.fromEntries(
          Object.entries(partial.serverConnectionOverrides).map(([k, v]) => [
            k,
            {
              ...(v.headersOverride !== undefined
                ? { headersOverride: { ...v.headersOverride } }
                : {}),
              ...(v.requestTimeoutOverride !== undefined
                ? { requestTimeoutOverride: v.requestTimeoutOverride }
                : {}),
              ...(v.mcpProtocolVersionOverride !== undefined
                ? { mcpProtocolVersionOverride: v.mcpProtocolVersionOverride }
                : {}),
            },
          ]),
        )
      : undefined,
  };
}
