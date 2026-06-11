/**
 * SDK→backend eval ingestion wire normalizer (Stage 5, Step 1).
 *
 * `normalizeSdkEvalHostConfigForWire` produces the byte-stable input that BOTH
 * the SDK eval reporter (Step 3) and the backend ingestion handler (Step 2)
 * feed into `canonicalizeHostConfigV2` + `computeHostConfigHashV2`. By
 * normalizing on the wire — not on either side independently — we guarantee
 * client and backend agree on the transport-integrity hash. The eventual
 * stored v2 `hostConfigs` row may have a different hash because backend
 * materialization layers suite-resolved Convex `serverIds` back in.
 *
 * The normalizer's only behavior is to STRIP fields that must not ride the
 * eval wire:
 *   - `serverIds`                  (runtime-manager identifiers, never `Id<'servers'>`)
 *   - `optionalServerIds`
 *   - `serverConnectionOverrides`  (server-keyed overrides also use runtime ids)
 *   - `computer`                   (mutable per-user state — an eval that shells
 *                                   into a personal computer isn't reproducible;
 *                                   the backend also rejects it at run start.
 *                                   See mcpjam-backend docs/project-computers.md)
 *
 * Everything else is preserved verbatim. We do NOT canonicalize, sort, hash,
 * or otherwise reshape — that's the canonicalizer's job. This is a thin,
 * lossy projection that produces a uniformly-shaped `HostConfigInputV2`
 * regardless of whether the caller fed us a canonical input or a public
 * `Host.toJSON()` snapshot.
 *
 * Shape acceptance (Stage 4 trap-log finding): some callers feed already-
 * canonical `HostConfigInputV2` (storage-row vocabulary: `hostStyle`,
 * `mcpProfile`, `serverIds`); others feed `HostJson` from `Host.toJSON()`
 * (public vocabulary: `style`, `mcp`, `servers`). Detect by discriminative
 * keys and project the public shape to the canonical input shape BEFORE
 * stripping.
 *
 * Pure, browser-safe, runtime-free. No `node:*`, `ai`, or `MCPClientManager`
 * imports — this file must stay in the `host-config/internal` bundle slice
 * that the inspector client and the Convex backend can both consume.
 */

import type {
  HostConfigInputV2,
  HostConfigMcpProfileV1,
} from "./types.js";
import type { HostJson, HostMcp } from "./public-types.js";

/**
 * Discriminate a canonical `HostConfigInputV2` from a public `HostJson`. We
 * use `hostStyle` (canonical) vs `style` (public) as the primary discriminator
 * because both shapes require a host style and the field rename is the
 * cleanest signal. Defensive: if the input has neither, fall through to a
 * minimal pass-through and let the canonicalizer downstream complain.
 */
function isHostConfigInputShape(value: unknown): value is HostConfigInputV2 {
  if (!value || typeof value !== "object") return false;
  return typeof (value as { hostStyle?: unknown }).hostStyle === "string";
}

function isHostJsonShape(value: unknown): value is HostJson {
  if (!value || typeof value !== "object") return false;
  const v = value as { style?: unknown; hostStyle?: unknown };
  return (
    typeof v.style === "string" && typeof v.hostStyle !== "string"
  );
}

/**
 * Project a public `HostMcp` → internal `mcpProfile` (storage-row vocabulary).
 * Mirrors `hostMcpToProfile` in `host.ts` but lives here so the normalizer is
 * self-contained for the `host-config/internal` bundle slice.
 */
function hostMcpToProfile(mcp: HostMcp): HostConfigMcpProfileV1 {
  const profile: HostConfigMcpProfileV1 = { profileVersion: 1 };
  if (mcp.protocolVersion !== undefined) {
    profile.mcpProtocolVersion = mcp.protocolVersion;
  }
  if (mcp.initialize !== undefined) profile.initialize = mcp.initialize;
  if (mcp.apps !== undefined) profile.apps = mcp.apps;
  if (mcp.extensions !== undefined) profile.extensions = mcp.extensions;
  return profile;
}

/**
 * Project a public `HostJson` to canonical `HostConfigInputV2`, then strip
 * the runtime-id-bearing fields. Done in one pass to avoid materializing the
 * doomed fields.
 */
function hostJsonToStrippedInput(json: HostJson): HostConfigInputV2 {
  const input: HostConfigInputV2 = {
    hostStyle: json.style,
    modelId: json.model,
    systemPrompt: json.systemPrompt,
    temperature: json.temperature,
    requireToolApproval: json.requireToolApproval,
    connectionDefaults: json.connectionDefaults,
    clientCapabilities: json.clientCapabilities,
    hostContext: json.hostContext,
  };
  if (json.progressiveToolDiscovery !== undefined) {
    input.progressiveToolDiscovery = json.progressiveToolDiscovery;
  }
  if (json.respectToolVisibility !== undefined) {
    input.respectToolVisibility = json.respectToolVisibility;
  }
  if (json.hostCapabilitiesOverride !== undefined) {
    input.hostCapabilitiesOverride = json.hostCapabilitiesOverride;
  }
  if (json.chatUiOverride !== undefined) {
    input.chatUiOverride = json.chatUiOverride;
  }
  if (json.mcp !== undefined) {
    input.mcpProfile = hostMcpToProfile(json.mcp);
  }
  // `servers`, `optionalServers`, `serverOverrides` deliberately dropped —
  // the wire form must not carry runtime-manager identifiers. `computer` is
  // dropped too: evals never target personal computers.
  return input;
}

/**
 * Strip the wire-forbidden fields (runtime ids + `computer`) from a canonical
 * input. Returns a fresh object; never mutates `input`.
 */
function stripRuntimeIdsFromCanonical(
  input: HostConfigInputV2,
): HostConfigInputV2 {
  const {
    // Intentionally destructured out so the rest spread drops them.
    serverIds: _serverIds,
    optionalServerIds: _optionalServerIds,
    serverConnectionOverrides: _serverConnectionOverrides,
    computer: _computer,
    ...rest
  } = input;
  // Discard the unused locals (silences `no-unused-vars` without disabling).
  void _serverIds;
  void _optionalServerIds;
  void _serverConnectionOverrides;
  void _computer;
  return { ...rest };
}

/**
 * Pass-1 wire normalizer for SDK→backend eval ingestion.
 *
 * Strips runtime-manager identifiers (`serverIds`, `optionalServerIds`,
 * `serverConnectionOverrides`) and the eval-forbidden `computer` field so the
 * SDK reporter and backend handler hash byte-identical wire shapes — and so
 * evals never carry a personal computer. Accepts EITHER a canonical
 * {@link HostConfigInputV2} OR a public {@link HostJson} (`Host.toJSON()`);
 * the public shape is projected to the canonical input shape before stripping.
 *
 * Pure, idempotent, side-effect-free.
 *
 * @param source canonical input or public `HostJson` snapshot
 * @returns a fresh `HostConfigInputV2` with runtime ids stripped
 */
export function normalizeSdkEvalHostConfigForWire(
  source: HostConfigInputV2 | HostJson,
): HostConfigInputV2 {
  if (isHostConfigInputShape(source)) {
    return stripRuntimeIdsFromCanonical(source);
  }
  if (isHostJsonShape(source)) {
    return hostJsonToStrippedInput(source);
  }
  // Neither shape: return a minimal pass-through. Downstream
  // `canonicalizeHostConfigV2` will reject it with a precise error (missing
  // required fields). The normalizer's contract is shape-only — it doesn't
  // duplicate validation that already lives in the canonicalizer.
  const minimal = source as HostConfigInputV2;
  return stripRuntimeIdsFromCanonical(minimal);
}
