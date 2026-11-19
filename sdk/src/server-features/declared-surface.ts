/**
 * Turns a stored inspection snapshot (any envelope version) into the
 * `DeclaredSurface` catalog rules read.
 *
 * The stored shape loses data in two known ways: Convex strips `$`/`_` keys
 * from nested objects, and the storage budget drops fields under pressure.
 * v3 producers send `*Json` fidelity strings beside stripped objects, and the
 * backend logs every budget drop in `redaction.droppedFields`. This reader
 * prefers the fidelity strings and marks the affected coverage partial, so a
 * rule can never read a dropped field as "not there".
 */

import {
  COVERAGE_KEYS,
  type CoverageKey,
  type CoverageState,
  type DeclaredItem,
  type DeclaredSurface,
  type ListCacheHints,
} from "./types.js";
import { normalizeCaptureTransport } from "./context.js";

export interface DeclaredSurfaceSource {
  /** `serverInspections` snapshot for one server (`readDoc().snapshot`). */
  snapshot: unknown;
  /** `readDoc().latestEnvelopeVersion`; falls back to the snapshot's own. */
  envelopeVersion?: number;
  /** `readDoc().redaction`; only `droppedFields` is read. */
  redaction?: unknown;
}

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Rec[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // A malformed fidelity string is treated as absent; the stripped object
    // beside it still describes the field.
    return undefined;
  }
}

/** Wire-shaped descriptor: fidelity strings restored to their MCP names. */
function restoreDescriptor(item: Rec): DeclaredItem {
  const {
    meta,
    metaJson,
    inputSchemaJson,
    outputSchemaJson,
    metadata,
    ...rest
  } = item;
  const out: Rec = { ...rest };
  const fullMeta = parseJson(metaJson) ?? meta ?? metadata;
  if (fullMeta !== undefined) out._meta = fullMeta;
  const input = parseJson(inputSchemaJson);
  if (input !== undefined) out.inputSchema = input;
  const output = parseJson(outputSchemaJson);
  if (output !== undefined) out.outputSchema = output;
  return out;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((entry): entry is string => typeof entry === "string");
  return out.length > 0 ? out : undefined;
}

function listHints(value: unknown): DeclaredSurface["listHints"] {
  if (!isRecord(value)) return {};
  const out: Partial<Record<keyof DeclaredSurface["listHints"], ListCacheHints>> =
    {};
  for (const key of ["tools", "resources", "resourceTemplates", "prompts"] as const) {
    const hint = value[key];
    if (!isRecord(hint)) continue;
    const entry: ListCacheHints = {};
    if (typeof hint.ttlMs === "number") entry.ttlMs = hint.ttlMs;
    if (typeof hint.cacheScope === "string") entry.cacheScope = hint.cacheScope;
    if (typeof hint.pages === "number") entry.pages = hint.pages;
    out[key] = entry;
  }
  return out;
}

const COVERAGE_RANK: Record<CoverageState, number> = {
  "not-captured": 0,
  partial: 1,
  complete: 2,
};

function weaker(a: CoverageState, b: CoverageState): CoverageState {
  return COVERAGE_RANK[a] <= COVERAGE_RANK[b] ? a : b;
}

/** Which coverage keys a dropped storage path weakens. */
function keysForDroppedPath(path: string): CoverageKey[] {
  if (/^tools\[\d+\]\.(meta|metaJson|metadata)/.test(path)) return ["toolMeta"];
  if (/^tools\[\d+\]\.(input|output)Schema/.test(path)) return ["toolSchemas"];
  if (/^tools\[\d+\]\.(annotations|icons|title|execution)/.test(path))
    return ["tools"];
  if (/^tools(\[|$)/.test(path)) return ["tools", "toolMeta", "toolSchemas"];
  if (/^discovery\.capabilities/.test(path)) return ["capabilities"];
  if (/^discovery\.serverInfo/.test(path)) return ["serverInfo"];
  if (/^discovery\.instructions/.test(path)) return ["instructions"];
  if (/^discovery\.(meta|metaJson)/.test(path)) return ["serverInfo"];
  if (/^discovery/.test(path))
    return ["serverInfo", "capabilities", "instructions"];
  for (const key of ["resourceTemplates", "resources", "prompts", "skills", "listHints"] as const) {
    if (path === key || path.startsWith(`${key}[`) || path.startsWith(`${key}.`))
      return [key];
  }
  return [];
}

function droppedFields(redaction: unknown): string[] {
  if (!isRecord(redaction)) return [];
  return stringList(redaction.droppedFields) ?? [];
}

/**
 * Coverage a pre-v3 snapshot can honestly claim. v1/v2 producers listed tools
 * fully but stripped `_meta` and schema keys, and (before the connect fix)
 * never saved serverInfo or capabilities, so nothing else counts as complete.
 */
function legacyCoverage(server: Rec): Record<CoverageKey, CoverageState> {
  const coverage = Object.fromEntries(
    COVERAGE_KEYS.map((key) => [key, "not-captured" as CoverageState]),
  ) as Record<CoverageKey, CoverageState>;
  const failed = typeof server.captureError === "string";
  coverage.tools = failed ? "not-captured" : "complete";
  coverage.toolMeta = failed ? "not-captured" : "partial";
  coverage.toolSchemas = failed ? "not-captured" : "partial";
  const discovery = isRecord(server.discovery) ? server.discovery : undefined;
  if (discovery && isRecord(discovery.serverInfo)) coverage.serverInfo = "partial";
  if (discovery && isRecord(discovery.capabilities))
    coverage.capabilities = "partial";
  if (discovery && typeof discovery.instructions === "string")
    coverage.instructions = "partial";
  return coverage;
}

function v3Coverage(server: Rec): Record<CoverageKey, CoverageState> {
  const declared = isRecord(server.coverage) ? server.coverage : {};
  const coverage = {} as Record<CoverageKey, CoverageState>;
  for (const key of COVERAGE_KEYS) {
    const value = declared[key];
    coverage[key] =
      value === "complete" || value === "partial" ? value : "not-captured";
  }
  if (typeof server.captureError === "string") {
    for (const key of COVERAGE_KEYS) coverage[key] = weaker(coverage[key], "partial");
  }
  return coverage;
}

export function toDeclaredSurface(
  source: DeclaredSurfaceSource,
): DeclaredSurface | undefined {
  const server = source.snapshot;
  if (!isRecord(server)) return undefined;
  const envelopeVersion =
    source.envelopeVersion ??
    (typeof server.version === "number" ? server.version : 2);

  const coverage =
    envelopeVersion >= 3 && isRecord(server.coverage)
      ? v3Coverage(server)
      : legacyCoverage(server);
  for (const path of droppedFields(source.redaction)) {
    for (const key of keysForDroppedPath(path)) {
      coverage[key] = weaker(coverage[key], "partial");
    }
  }

  const discovery = isRecord(server.discovery)
    ? server.discovery
    : isRecord(server.initialize)
      ? server.initialize
      : {};
  const capabilities =
    parseJson(discovery.capabilitiesJson) ?? discovery.capabilities;
  const discoveryMeta = parseJson(discovery.metaJson) ?? discovery.meta;

  const surface: DeclaredSurface = {
    envelopeVersion,
    tools: records(server.tools).map(restoreDescriptor),
    resources: records(server.resources).map(restoreDescriptor),
    resourceTemplates: records(server.resourceTemplates).map(restoreDescriptor),
    prompts: records(server.prompts).map(restoreDescriptor),
    skills: records(server.skills).map(restoreDescriptor),
    listHints: listHints(server.listHints),
    coverage,
    transport: normalizeCaptureTransport(server.transport),
  };
  if (typeof discovery.protocolVersion === "string")
    surface.protocolVersion = discovery.protocolVersion;
  const supportedVersions = stringList(discovery.supportedVersions);
  if (supportedVersions) surface.supportedVersions = supportedVersions;
  if (isRecord(discovery.serverInfo)) surface.serverInfo = discovery.serverInfo;
  if (typeof discovery.instructions === "string")
    surface.instructions = discovery.instructions;
  if (isRecord(capabilities)) surface.capabilities = capabilities;
  if (isRecord(discoveryMeta)) surface.discoveryMeta = discoveryMeta;
  return surface;
}
