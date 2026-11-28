/**
 * Capture context and its hash. Evidence is stored and read per context hash,
 * so the Inspector server (writer) and the browser (reader) must hash the
 * same way; both import this module.
 */

import type { CaptureContext, CaptureTransport } from "./types.js";

const MODERN_VERSIONS = new Set(["2026-07-28"]);
const LEGACY_VERSIONS = new Set([
  "2024-10-07",
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);

/** Era of a protocol version, "unknown" when we have no rules for it. */
export function protocolEra(
  version: string | undefined,
): "legacy" | "modern" | "unknown" {
  if (!version) return "unknown";
  if (MODERN_VERSIONS.has(version)) return "modern";
  if (LEGACY_VERSIONS.has(version)) return "legacy";
  return "unknown";
}

export function normalizeCaptureTransport(value: unknown): CaptureTransport {
  if (value === "stdio" || value === "sse") return value;
  if (value === "streamable-http" || value === "http") return "streamable-http";
  return "unknown";
}

function sortedUnique(values: readonly string[] | undefined) {
  if (!values || values.length === 0) return undefined;
  return [...new Set(values)].sort();
}

/** Drops empty fields and sorts sets so equal contexts hash equally. */
export function normalizeCaptureContext(
  context: CaptureContext,
): CaptureContext {
  const era = context.era ?? protocolEra(context.protocolVersion);
  const clientExtensions = sortedUnique(context.clientExtensions);
  const out: CaptureContext = { transport: context.transport, era };
  if (context.protocolVersion) out.protocolVersion = context.protocolVersion;
  if (context.clientCapabilitiesHash)
    out.clientCapabilitiesHash = context.clientCapabilitiesHash;
  if (clientExtensions) out.clientExtensions = clientExtensions;
  if (context.hostProfile) out.hostProfile = context.hostProfile;
  if (context.environmentId) out.environmentId = context.environmentId;
  if (context.accountBinding) out.accountBinding = context.accountBinding;
  if (context.configRevision) out.configRevision = context.configRevision;
  return out;
}

/** Stable JSON: object keys sorted at every level. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** FNV-1a over UTF-16 code units, 32-bit, as 8 hex chars. */
function fnv1a(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 64 bits from two seeds; collisions only merge evidence views, never data. */
export function stableHash(value: unknown): string {
  const text = stableStringify(value);
  return `${fnv1a(text, 0x811c9dc5)}${fnv1a(text, 0x01000193)}`;
}

/** Hash that keys stored evidence: `ctx_` + 16 hex chars. */
export function computeCaptureContextHash(context: CaptureContext): string {
  return `ctx_${stableHash(normalizeCaptureContext(context))}`;
}

/** Hash of client capabilities, for `CaptureContext.clientCapabilitiesHash`. */
export function hashClientCapabilities(capabilities: unknown): string {
  return `cc_${stableHash(capabilities ?? {})}`;
}

/** Extension ids a client advertised under `capabilities.extensions`. */
export function clientExtensionIds(capabilities: unknown): string[] {
  if (!capabilities || typeof capabilities !== "object") return [];
  const extensions = (capabilities as Record<string, unknown>).extensions;
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions))
    return [];
  return Object.keys(extensions).sort();
}
