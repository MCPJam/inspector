/**
 * Frontend types + utilities for HostConfig v2.
 *
 * Mirrors the shape declared in the backend's
 * `convex/lib/hostConfigV2.ts`. Kept in sync by hand: this file is the
 * single client-side source of truth so all four editors (Project Settings,
 * Chatbox Editor/Builder, Eval Suite Settings, Connection Settings) speak
 * one shape.
 *
 * Phase 1 (additive). Subsequent phases will switch read/write paths in
 * place; the shape below is stable.
 */

import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { ChatboxHostStyle } from "@/lib/chatbox-host-style";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  stableStringifyJson,
} from "@/lib/client-config";
import { getHostCapabilitiesForStyle } from "@/lib/host-styles";
import { getDefaultClientCapabilities } from "@mcpjam/sdk/browser";

export type HostStyleId = ChatboxHostStyle;

export type HostConfigConnectionDefaults = {
  headers: Record<string, string>;
  requestTimeout: number;
};

/**
 * Set of CSP domain lists keyed by directive family. Mirrors the
 * backend `CspDomainSet` in `convex/lib/hostConfigV2.ts`. The backend
 * canonicalizes these as **sets** — order does not affect the row hash
 * (trim → dedupe → sort). The frontend MUST treat them the same so
 * the editor's "no changes" detection (`hostConfigInputsEqual`) doesn't
 * report a cosmetic reorder as dirty.
 */
export type CspDomainSet = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

/**
 * Versioned envelope for host-level MCP state — clientInfo, supported
 * protocol versions, MCP Apps sandbox policy. Mirrors backend
 * `HostConfigMcpProfileV1`. The semantics are spec-driven; copy the
 * shape verbatim and do NOT re-derive intent here.
 *
 * **`undefined` means "SDK defaults".** This file's helpers must
 * preserve that — never substitute `{}` or `{ profileVersion: 1 }` as
 * a default, because the backend treats those three as distinct
 * (different canonical hashes). The save round-trip contract is:
 * `undefined` in → `undefined` out.
 */
export type HostConfigMcpProfileV1 = {
  profileVersion: 1;
  initialize?: {
    /**
     * Order is semantic. First entry is proposed in
     * `initialize.params.protocolVersion`; all entries form the
     * accept-list. A single-item array pins a reproducible version.
     */
    supportedProtocolVersions?: string[];
    /**
     * The exact `initialize.clientInfo` object the SDK should send to
     * MCP servers. Required when set: `name` + `version`. Extra fields
     * (`title`, future spec additions) pass through verbatim.
     */
    clientInfo?: Record<string, unknown>;
  };
  apps?: {
    sandbox?: {
      csp?: {
        /**
         * `declared` — baseline is the resource's `_meta.ui.csp`.
         * `host-default` — baseline is the inspector's renderer default.
         * `relaxed` — permissive baseline (hosted-mode clamp still applies).
         *
         * Picking a mode does NOT skip `restrictTo` / `deny` — those
         * always apply on top of whichever baseline `mode` selects.
         */
        mode?: "host-default" | "declared" | "relaxed";
        /**
         * Intersection — final set = baseline ∩ restrictTo. Per
         * SEP-1865 the host MAY restrict but MUST NOT add undeclared
         * domains.
         */
        restrictTo?: CspDomainSet;
        /** Subtraction — always wins over baseline and over `restrictTo`. */
        deny?: CspDomainSet;
        extensions?: Record<string, unknown>;
      };
      permissions?: {
        /**
         * `resource-declared` — pass the resource's declaration through.
         * `deny-all` — emit no `allow=` attribute.
         * `custom` — use `allow` as the candidate set then subtract `deny`.
         */
        mode?: "resource-declared" | "deny-all" | "custom";
        allow?: Record<string, boolean>;
        deny?: string[];
        extensions?: Record<string, unknown>;
      };
    };
  };
  extensions?: Record<string, unknown>;
};

/**
 * Mutable input shape. All fields are required at write time so the editor
 * can't accidentally erase a section.
 */
export type HostConfigInputV2 = {
  hostStyle: HostStyleId;
  modelId: string;
  systemPrompt: string;
  temperature: number;
  requireToolApproval: boolean;
  serverIds: string[];
  optionalServerIds: string[];
  connectionDefaults: HostConfigConnectionDefaults;
  clientCapabilities: Record<string, unknown>;
  hostContext: Record<string, unknown>;
  /**
   * User override for the MCP Apps `hostCapabilities` blob advertised in the
   * `ui/initialize` response. When undefined, the renderer falls back to the
   * preset declared by the active `hostStyle`. Tracked as an **override** so
   * source is unambiguous: switching host styles must not drag a stale base
   * value along, and "Reset to profile" is a one-line undefined write.
   */
  hostCapabilitiesOverride?: Record<string, unknown>;
  /**
   * Versioned envelope for host-level MCP state (clientInfo, supported
   * protocol versions, MCP Apps sandbox policy). Optional; `undefined`
   * means "use SDK defaults / no host-level sandbox override." The
   * backend treats `undefined`, `{}`, and `{ profileVersion: 1 }` as
   * three distinct canonical hashes — never substitute a default here.
   */
  mcpProfile?: HostConfigMcpProfileV1;
};

/**
 * Hydrated DTO returned by v2 read paths. Includes the row id so the editor
 * can detect "no change" vs "modified" and skip unnecessary writes.
 */
export type HostConfigDtoV2 = {
  id: string;
  schemaVersion: number;
  hostStyle: HostStyleId;
  modelId: string;
  systemPrompt: string;
  temperature: number;
  requireToolApproval: boolean;
  serverIds: string[];
  optionalServerIds: string[];
  connectionDefaults: HostConfigConnectionDefaults;
  clientCapabilities: Record<string, unknown>;
  hostContext: Record<string, unknown>;
  /** Optional user override (see HostConfigInputV2.hostCapabilitiesOverride). */
  hostCapabilitiesOverride?: Record<string, unknown>;
  /**
   * Surfaced verbatim from the backend DTO. `undefined` is meaningful
   * ("no host-level profile — fall back to SDK defaults") and must
   * round-trip back through save paths unchanged. See
   * HostConfigInputV2.mcpProfile.
   */
  mcpProfile?: HostConfigMcpProfileV1;
};

export const DEFAULT_HOST_STYLE_V2: HostStyleId = "claude";
export const DEFAULT_TEMPERATURE_V2 = 0.7;

export function emptyHostConfigInputV2(
  partial: Partial<HostConfigInputV2> = {},
): HostConfigInputV2 {
  // Clone every caller-provided array/record so the returned config can
  // be mutated freely without aliasing the input. Matches the cloning
  // behavior of hostConfigDtoToInput.
  return {
    hostStyle: partial.hostStyle ?? DEFAULT_HOST_STYLE_V2,
    modelId: partial.modelId ?? "",
    systemPrompt: partial.systemPrompt ?? "",
    temperature: partial.temperature ?? DEFAULT_TEMPERATURE_V2,
    requireToolApproval: partial.requireToolApproval ?? false,
    serverIds: partial.serverIds ? [...partial.serverIds] : [],
    optionalServerIds: partial.optionalServerIds
      ? [...partial.optionalServerIds]
      : [],
    connectionDefaults: {
      headers: partial.connectionDefaults?.headers
        ? { ...partial.connectionDefaults.headers }
        : {},
      requestTimeout:
        partial.connectionDefaults?.requestTimeout ??
        DEFAULT_REQUEST_TIMEOUT_MS,
    },
    // Seed with the SDK's default capabilities (which include the MCP UI
    // extension and any other built-ins) so a brand-new project/chatbox/
    // eval host config keeps advertising them. The legacy
    // ProjectClientConfig path also seeds from getDefaultClientCapabilities;
    // an empty {} here would silently drop MCP Apps support until the
    // user manually edited the capability JSON.
    //
    // Deep-clone — clientCapabilities and hostContext can be nested
    // (e.g. extensions.mimeTypes arrays). A shallow spread would alias
    // the inner trees with the partial/source, allowing later mutations
    // to leak through.
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
    // Deep-clone the profile if provided, otherwise leave undefined.
    // Do NOT substitute `{ profileVersion: 1 }` as a "default empty"
    // envelope — the backend treats undefined vs an empty envelope as
    // distinct hashes (the latter signals "user opted into a profile
    // but configured nothing"). Round-tripping the wrong value here
    // would silently churn the row's _id.
    mcpProfile: partial.mcpProfile
      ? cloneMcpProfile(partial.mcpProfile)
      : undefined,
  };
}

export function hostConfigDtoToInput(
  dto: HostConfigDtoV2,
): HostConfigInputV2 {
  // Deep-clone the JSON record fields. clientCapabilities and
  // hostContext can be nested (e.g. the SDK's default capabilities
  // include an `extensions` object with arrays). A shallow spread
  // would leave the inner trees aliased to the source DTO; any nested
  // edit through the returned input would silently mutate the
  // baseline used for resets and dirty comparisons.
  return {
    hostStyle: dto.hostStyle,
    modelId: dto.modelId,
    systemPrompt: dto.systemPrompt,
    temperature: dto.temperature,
    requireToolApproval: dto.requireToolApproval,
    serverIds: [...dto.serverIds],
    optionalServerIds: [...dto.optionalServerIds],
    connectionDefaults: {
      headers: { ...dto.connectionDefaults.headers },
      requestTimeout: dto.connectionDefaults.requestTimeout,
    },
    clientCapabilities: deepCloneJsonRecord(dto.clientCapabilities),
    hostContext: deepCloneJsonRecord(dto.hostContext),
    hostCapabilitiesOverride: dto.hostCapabilitiesOverride
      ? deepCloneJsonRecord(dto.hostCapabilitiesOverride)
      : undefined,
    mcpProfile: dto.mcpProfile ? cloneMcpProfile(dto.mcpProfile) : undefined,
  };
}

/**
 * Deep-clone a HostConfigMcpProfileV1. Preserves the
 * `undefined`-means-default contract: nested optionals stay `undefined`,
 * NOT `{}`, so JSON.stringify produces the same wire bytes as the
 * source envelope.
 */
function cloneMcpProfile(
  profile: HostConfigMcpProfileV1,
): HostConfigMcpProfileV1 {
  return deepCloneJsonValue(profile) as HostConfigMcpProfileV1;
}

/**
 * Resolve the `hostCapabilities` blob the MCP Apps iframe handshake should
 * advertise for a given host config. Precedence:
 *   1. User-saved `hostCapabilitiesOverride` (verbatim, when present)
 *   2. The active host style's preset
 *   3. Spec-default "no claims" baseline (handled inside
 *      {@link getHostCapabilitiesForStyle})
 *
 * **Sandbox is intentionally NOT resolved here.** Per SEP-1865, sandbox
 * CSP/permissions are approved per-UI-resource at runtime and merged into
 * the final blob by the renderer. Profile presets and user overrides cover
 * vendor-trait fields only.
 *
 * **Conformance gap (advertise vs. enforce):** This returns the value the
 * handshake will advertise. Until enforcement gates land in the renderer's
 * request handlers, behavior may still service methods this blob omits.
 * Use this value as the single source of truth when enforcement ships so
 * advertise and enforce stay in lockstep.
 */
export function resolveEffectiveHostCapabilities(args: {
  hostStyle: HostStyleId | null | undefined;
  hostCapabilitiesOverride?: Record<string, unknown>;
}): Omit<McpUiHostCapabilities, "sandbox"> {
  // `!== undefined` (not truthy-check): `{}` is a meaningful override
  // ("advertise nothing") and must take the strip-then-return path, not
  // silently fall through to the preset.
  if (args.hostCapabilitiesOverride !== undefined) {
    // Strip `sandbox` defensively: the JSON editor doesn't prevent users
    // from typing it in, and leaking a static sandbox blob into the
    // advertised handshake would violate the per-resource sandbox rule
    // (SEP-1865 — sandbox is approved per UI resource at runtime, not as
    // a vendor trait). Matches the return-type contract.
    const { sandbox: _sandbox, ...rest } = args.hostCapabilitiesOverride as {
      sandbox?: unknown;
    } & Record<string, unknown>;
    return rest as Omit<McpUiHostCapabilities, "sandbox">;
  }
  return getHostCapabilitiesForStyle(args.hostStyle);
}

/**
 * Resolve the clientInfo the upstream MCP `initialize` request should
 * carry. Returns `undefined` to signal "use SDK defaults" — callers
 * (the SDK's MCPClientManager wiring) must interpret `undefined` as
 * "don't pass me anything; let the SDK fall back to its hardcoded
 * client name / version."
 *
 * NEVER returns a synthesized default object. A profile without
 * `initialize.clientInfo` set MUST yield `undefined` here, otherwise
 * the SDK loses its ability to distinguish "user pinned an identity"
 * from "user wants SDK defaults."
 */
export function resolveClientInfo(
  profile: HostConfigMcpProfileV1 | undefined,
): Record<string, unknown> | undefined {
  return profile?.initialize?.clientInfo;
}

/**
 * Resolve the accept-list of MCP protocol versions for the upstream
 * `initialize`. First entry is the one proposed in
 * `params.protocolVersion`. Returns `undefined` to signal "use SDK
 * defaults" — same contract as {@link resolveClientInfo}.
 *
 * A non-empty array is the backend's invariant when the field is set
 * (validated in `canonicalizeHostConfigV2`), so callers can rely on
 * `versions.length > 0` whenever this returns a defined value.
 */
export function resolveSupportedProtocolVersions(
  profile: HostConfigMcpProfileV1 | undefined,
): string[] | undefined {
  const versions = profile?.initialize?.supportedProtocolVersions;
  if (!versions || versions.length === 0) return undefined;
  return [...versions];
}

function deepCloneJsonRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return deepCloneJsonValue(value) as Record<string, unknown>;
}

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

/**
 * Equality on the canonical fields (ignoring `id` and any extra
 * metadata). Used by editors to detect "no changes" before submitting.
 *
 * Headers/clientCapabilities/hostContext are compared as JSON-serialized
 * deep trees (key order normalized via sorting). This is intentional: they
 * may legitimately be nested objects, and reference equality would always
 * be false after `hostConfigDtoToInput` clones them.
 */
export function hostConfigInputsEqual(
  a: HostConfigInputV2,
  b: HostConfigInputV2,
): boolean {
  if (a.hostStyle !== b.hostStyle) return false;
  if (a.modelId !== b.modelId) return false;
  if (a.systemPrompt !== b.systemPrompt) return false;
  if (a.temperature !== b.temperature) return false;
  if (a.requireToolApproval !== b.requireToolApproval) return false;
  if (!stringArrayEq(a.serverIds, b.serverIds)) return false;
  if (!stringArrayEq(a.optionalServerIds, b.optionalServerIds)) return false;
  if (
    a.connectionDefaults.requestTimeout !==
    b.connectionDefaults.requestTimeout
  )
    return false;
  if (!jsonRecordEq(a.connectionDefaults.headers, b.connectionDefaults.headers))
    return false;
  if (!jsonRecordEq(a.clientCapabilities, b.clientCapabilities)) return false;
  if (!jsonRecordEq(a.hostContext, b.hostContext)) return false;
  if (!optionalJsonRecordEq(a.hostCapabilitiesOverride, b.hostCapabilitiesOverride))
    return false;
  if (!mcpProfileEq(a.mcpProfile, b.mcpProfile)) return false;
  return true;
}

/**
 * Profile equality that mirrors the backend's canonicalization rules:
 * - `undefined` and `{ profileVersion: 1 }` are distinct (backend
 *   hashes them differently to preserve the "user opted in" signal).
 * - `supportedProtocolVersions` order is **semantic** — different
 *   orderings hash differently and must compare as unequal here.
 * - CSP domain arrays under `restrictTo` / `deny` are **sets** —
 *   order does not affect canonical hash; the editor MUST treat them
 *   the same, otherwise a cosmetic reorder shows as dirty when the
 *   backend would dedupe to the same row.
 *
 * Anything else inside the envelope deep-compares with key-order
 * normalization (same rule as clientCapabilities / hostContext).
 */
function mcpProfileEq(
  a: HostConfigMcpProfileV1 | undefined,
  b: HostConfigMcpProfileV1 | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  // Canonicalize CSP domain sets in-place on clones so the
  // stableStringifyJson compares the same shape the backend stores.
  return (
    stableStringifyJson(canonicalizeMcpProfileForEquality(a)) ===
    stableStringifyJson(canonicalizeMcpProfileForEquality(b))
  );
}

function canonicalizeMcpProfileForEquality(
  profile: HostConfigMcpProfileV1,
): Record<string, unknown> {
  const clone = cloneMcpProfile(profile);
  const csp = clone.apps?.sandbox?.csp;
  if (csp?.restrictTo) csp.restrictTo = sortCspDomainSet(csp.restrictTo);
  if (csp?.deny) csp.deny = sortCspDomainSet(csp.deny);
  const perms = clone.apps?.sandbox?.permissions;
  if (perms?.deny) {
    // Permission deny lists are sets too (matches backend's
    // `Array.from(new Set(...)).sort()`).
    perms.deny = Array.from(
      new Set(perms.deny.map((s) => s.trim()).filter((s) => s !== "")),
    ).sort();
  }
  return clone as unknown as Record<string, unknown>;
}

function sortCspDomainSet(set: CspDomainSet): CspDomainSet {
  const out: CspDomainSet = {};
  for (const k of [
    "connectDomains",
    "resourceDomains",
    "frameDomains",
    "baseUriDomains",
  ] as const) {
    const list = set[k];
    if (list === undefined) continue;
    out[k] = Array.from(
      new Set(list.map((s) => s.trim()).filter((s) => s !== "")),
    ).sort();
  }
  return out;
}

function optionalJsonRecordEq(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  // Treat `undefined` (use profile preset) and `{}` (explicit empty override)
  // as distinct values — flipping between them changes the resolved blob and
  // must register as dirty.
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return jsonRecordEq(a, b);
}

function stringArrayEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
}

function jsonRecordEq(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  // Use the shared canonicalizer so nested object key order doesn't make
  // semantically equal records compare unequal — e.g.
  // { capabilities: { a: 1, b: 2 } } vs { capabilities: { b: 2, a: 1 } }.
  // Top-level-only sorting (the previous implementation) reported these
  // as different and produced spurious dirty state in editors.
  return stableStringifyJson(a) === stableStringifyJson(b);
}
