/**
 * Translate a resolved per-server `mcpProtocolVersion` pin into the official
 * SDK client's `ClientOptions.versionNegotiation`.
 *
 * This is the config → SDK-policy mapping the official-client cutover (Phase
 * 1B of the MCP 2026-07-28 migration) routes on: once modern connections go
 * through the upstream `Client` instead of the hand-rolled preview, a
 * `2026-07-28` pin becomes a `versionNegotiation` pin rather than a branch to a
 * second client implementation.
 *
 * The manager resolves the pin (host default + per-server override +
 * `isKnownProtocolVersion` validation) before this runs; this module only maps
 * a validated value to negotiation policy. It is intentionally separate from
 * `mcp-protocol-version.ts` (which is hand-mirrored into the backend and must
 * stay free of any `@modelcontextprotocol/client` dependency).
 */

import type { VersionNegotiationOptions } from "@modelcontextprotocol/client";
import {
  isStatelessProtocolVersion,
  type McpProtocolVersion,
} from "./mcp-protocol-version.js";

/**
 * Negotiation strategies an unpinned HTTP connection can take instead of Auto,
 * each reproducing a real client's measured handshake. A pin always wins.
 *
 * - `"legacy-first"` — Cursor CLI's: open with the 2025 `initialize` (the first
 *   pre-2026 entry of `supportedProtocolVersions`, else the SDK's newest) and
 *   never probe `server/discover` first. Only a `-32022` refusal whose
 *   `data.supported` lists {@link LEGACY_FIRST_FALLBACK_VERSION} moves the
 *   connection to `server/discover` at that revision. Any other refusal fails
 *   the connect after the usual SSE attempt, whose GET the CLI also makes.
 */
export const VERSION_NEGOTIATION_PREFERENCES = ["legacy-first"] as const;
export type VersionNegotiationPreference =
  (typeof VERSION_NEGOTIATION_PREFERENCES)[number];

/** The one revision `"legacy-first"` falls back to, as the CLI does. */
export const LEGACY_FIRST_FALLBACK_VERSION = "2026-07-28" as const;

/**
 * Map a resolved pin to `ClientOptions.versionNegotiation`.
 *
 * - **Modern-era pin** (`2026-07-28`, per `isStatelessProtocolVersion`) →
 *   `{ mode: { pin } }`: negotiate exactly that revision. The connect-time
 *   `server/discover` must offer it; there is no legacy fallback.
 * - **Stateful pin** (`2025-*`) → `undefined`: run the exact legacy
 *   `initialize` handshake. The specific revision still travels via
 *   `ClientOptions.supportedProtocolVersions`; this function does not touch
 *   that accept-list.
 * - **No pin, `"legacy-first"`** → `undefined`: the exact legacy handshake,
 *   with the manager's one fallback (`legacyFirstFallback`).
 * - **No pin** → `{ mode: "auto" }`: probe with `server/discover`, selecting
 *   the modern era only on definitive modern evidence. Fallback is
 *   deliberately broad — per the official client's documented contract,
 *   definitive legacy signals AND anything unrecognized (opaque `400`, `404`,
 *   `405`, `406`, `5xx`, `-32601`) fall back to the plain `initialize`
 *   handshake on the same connection, byte-equivalent to a 2025 client.
 *   Exactly two outcomes fail the connect instead of falling back: a network
 *   outage, and a probe timeout on HTTP (silence from a deployed server
 *   indicates an outage, not a legacy server; on stdio a timeout IS a legacy
 *   signal and falls back).
 *
 * Automatic negotiation is ALWAYS ON and transport-agnostic: the manager
 * calls this helper for both HTTP and stdio servers. An unconfigured
 * connection resolves to `{ mode: "auto" }` on either transport (on stdio the
 * `server/discover` probe runs on a sibling process — the server binary is
 * spawned a second time). Explicit pins are honored on HTTP connections only;
 * stdio always negotiates in `auto` mode, because `mcpProtocolVersion` is
 * HTTP-only and the manager never forwards a pin to a stdio transport.
 */
export function resolveVersionNegotiation(
  mcpProtocolVersion: McpProtocolVersion | undefined,
  preference?: VersionNegotiationPreference
): VersionNegotiationOptions | undefined {
  if (mcpProtocolVersion === undefined) {
    return preference === "legacy-first" ? undefined : { mode: "auto" };
  }
  if (isStatelessProtocolVersion(mcpProtocolVersion)) {
    return { mode: { pin: mcpProtocolVersion } };
  }
  return undefined;
}

/**
 * The revision a failed legacy-first connect retries on, or `undefined` when
 * the config is not legacy-first or the failure is not the CLI's fallback
 * signal: `initialize` refused with `-32022` UnsupportedProtocolVersion whose
 * `data.supported` lists {@link LEGACY_FIRST_FALLBACK_VERSION}. The refusal is
 * a `400` whose body the transport puts on the error it throws (`data.text`),
 * or a JSON-RPC error the client raised; either may sit down the cause chain.
 */
export function legacyFirstFallback(
  config: {
    versionNegotiation?: VersionNegotiationPreference;
    mcpProtocolVersion?: McpProtocolVersion;
  },
  error: unknown
): typeof LEGACY_FIRST_FALLBACK_VERSION | undefined {
  if (
    config.versionNegotiation !== "legacy-first" ||
    config.mcpProtocolVersion !== undefined
  ) {
    return undefined;
  }
  let candidate = error;
  for (
    let hops = 0;
    candidate && typeof candidate === "object" && hops < 8;
    hops++
  ) {
    const refusal = jsonRpcRefusal(candidate);
    const supported = (refusal?.data as { supported?: unknown } | undefined)
      ?.supported;
    if (
      refusal?.code === -32022 &&
      Array.isArray(supported) &&
      supported.includes(LEGACY_FIRST_FALLBACK_VERSION)
    ) {
      return LEGACY_FIRST_FALLBACK_VERSION;
    }
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return undefined;
}

function jsonRpcRefusal(
  candidate: object
): { code?: unknown; data?: unknown } | undefined {
  const { code, data } = candidate as { code?: unknown; data?: unknown };
  if (typeof code === "number") return { code, data };
  const text = (data as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string") return undefined;
  try {
    return (JSON.parse(text) as { error?: { code?: unknown; data?: unknown } })
      .error;
  } catch {
    // Not a JSON-RPC body (an HTML error page, a proxy's text): no signal.
    return undefined;
  }
}
