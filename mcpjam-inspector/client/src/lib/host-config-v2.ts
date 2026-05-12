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
  };
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
  if (args.hostCapabilitiesOverride) {
    return args.hostCapabilitiesOverride as Omit<
      McpUiHostCapabilities,
      "sandbox"
    >;
  }
  return getHostCapabilitiesForStyle(args.hostStyle);
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
  return true;
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
