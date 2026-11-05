import { withAbortSignalFetch } from "../abort-signal.js";
import {
  MCP_CHECK_CATEGORIES,
  MCP_CHECK_IDS,
  MCP_LOG_LEVELS,
  MCP_READINESS_IDS,
  PROTOCOL_VERSION_ERAS,
  RETIRED_MCP_CHECK_IDS,
  type MCPCheckCategory,
  type MCPCheckEra,
  type MCPCheckId,
  type MCPConformanceConfig,
  type MCPReadinessId,
  type NormalizedMCPConformanceConfig,
} from "./types.js";
import {
  isKnownProtocolVersion,
  type McpProtocolVersion,
} from "../mcp-client-manager/mcp-protocol-version.js";

function normalizeCategories(
  categories: MCPConformanceConfig["categories"],
): MCPCheckCategory[] {
  if (!categories || categories.length === 0) {
    return [...MCP_CHECK_CATEGORIES];
  }

  const normalized = Array.from(new Set(categories));
  for (const category of normalized) {
    if (!MCP_CHECK_CATEGORIES.includes(category)) {
      throw new Error(`Unknown MCP conformance category: ${category}`);
    }
  }

  return normalized;
}

function normalizeCheckIds(
  checkIds: MCPCheckId[] | undefined,
): MCPCheckId[] | undefined {
  if (!checkIds || checkIds.length === 0) {
    return undefined;
  }

  const normalized = Array.from(new Set(checkIds));
  for (const checkId of normalized) {
    if (!MCP_CHECK_IDS.includes(checkId)) {
      throw new Error(`Unknown MCP conformance check id: ${checkId}`);
    }
  }

  return normalized;
}

/**
 * Picks with each retired check id swapped for the advice that replaced it.
 * Advice runs whatever checks are picked, so the advice is added only when
 * the caller narrowed it. A retired id picked on its own keeps the run to the
 * logging check, which calls the same log tool: an emptied list would run
 * every check instead.
 */
function resolveRetiredCheckIds(
  checkIds: MCPConformanceConfig["checkIds"],
  readinessIds: MCPConformanceConfig["readinessIds"],
): { checkIds?: MCPCheckId[]; readinessIds?: MCPReadinessId[] } {
  const retired = (checkIds ?? []).filter((id) =>
    Object.hasOwn(RETIRED_MCP_CHECK_IDS, id),
  ) as (keyof typeof RETIRED_MCP_CHECK_IDS)[];
  if (retired.length === 0) {
    return { checkIds: checkIds as MCPCheckId[] | undefined, readinessIds };
  }
  const current = checkIds!.filter(
    (id) => !Object.hasOwn(RETIRED_MCP_CHECK_IDS, id),
  ) as MCPCheckId[];
  return {
    checkIds:
      current.length > 0 ? current : ["modern-logs-require-log-level"],
    readinessIds:
      readinessIds === undefined
        ? undefined
        : [
            ...readinessIds,
            ...retired.map((id) => RETIRED_MCP_CHECK_IDS[id]),
          ],
  };
}

/** Unlike check ids, an empty list stays empty: it means no advice at all. */
function normalizeReadinessIds(
  readinessIds: MCPConformanceConfig["readinessIds"]
): MCPReadinessId[] | undefined {
  if (readinessIds === undefined) {
    return undefined;
  }

  const normalized = Array.from(new Set(readinessIds));
  for (const readinessId of normalized) {
    if (!MCP_READINESS_IDS.includes(readinessId)) {
      throw new Error(`Unknown MCP conformance readiness id: ${readinessId}`);
    }
  }

  return normalized;
}

/**
 * Era of a protocol version, read off the {@link PROTOCOL_VERSION_ERAS}
 * registry (§15.1). An unrecognized version is a CONFIGURATION ERROR, never a
 * silent fall back to legacy: running the legacy check set against a version
 * nobody classified would report a verdict about the wrong requirements.
 */
export function eraForProtocolVersion(protocolVersion: string): MCPCheckEra {
  if (!isKnownProtocolVersion(protocolVersion)) {
    throw new Error(
      `Unknown MCP conformance protocolVersion: ${protocolVersion}`,
    );
  }
  return PROTOCOL_VERSION_ERAS[protocolVersion];
}

function normalizeProtocolVersion(
  protocolVersion: MCPConformanceConfig["protocolVersion"],
): { protocolVersion?: McpProtocolVersion; era: MCPCheckEra } {
  if (protocolVersion === undefined) {
    // Unset ⇒ legacy era ⇒ byte-identical pre-era-awareness behavior.
    return { era: "legacy" };
  }

  return {
    protocolVersion,
    era: eraForProtocolVersion(protocolVersion),
  };
}

function normalizeToolProbe(
  probe: MCPConformanceConfig["inputRequiredProbe"],
  optionName: "inputRequiredProbe" | "logProbe" | "logLevelFilteringProbe",
): NormalizedMCPConformanceConfig["inputRequiredProbe"] {
  if (!probe) {
    return undefined;
  }

  const toolName = probe.toolName.trim();
  if (!toolName) {
    throw new Error(
      `MCP conformance ${optionName} requires a non-empty toolName`,
    );
  }

  return { toolName, arguments: probe.arguments };
}

function normalizeLogProbe(
  probe: MCPConformanceConfig["logProbe"],
  optionName: "logProbe" | "logLevelFilteringProbe" = "logProbe"
): NormalizedMCPConformanceConfig["logProbe"] {
  const normalized = normalizeToolProbe(probe, optionName);
  if (!normalized || probe?.level === undefined) {
    return normalized;
  }
  if (!(MCP_LOG_LEVELS as readonly string[]).includes(probe.level)) {
    throw new Error(
      `MCP conformance ${optionName}.level must be one of ${MCP_LOG_LEVELS.join(", ")}, got ${JSON.stringify(probe.level)}`
    );
  }
  return { ...normalized, level: probe.level };
}

/**
 * A fixture's `arguments` must be a plain object, or absent.
 *
 * Checked BEFORE its entries, and that order is the whole point: `Object.entries`
 * does not throw on a non-object, it coerces. A string spreads into
 * index/character pairs whose values are all strings (`"Ada"` → `[["0","A"], …]`),
 * and a number or boolean yields NO entries at all. Every one of those passes a
 * values-only loop and is then forwarded verbatim as `params.arguments` —
 * exactly the malformed request this guard exists to prevent, and one that
 * `wire-schema-valid` would report against the SERVER.
 *
 * Both request schemas type this member as an object: `CallToolRequestParams`
 * as `{"type": "object", "additionalProperties": {}}`, `GetPromptRequestParams`
 * as `Record<string, string>`. The VALUE rule differs between them, so callers
 * apply that themselves; the container rule is shared.
 */
function assertFixtureArgumentsContainer<T>(
  args: T,
  label: string,
): T {
  if (
    args !== undefined &&
    (args === null || typeof args !== "object" || Array.isArray(args))
  ) {
    throw new Error(
      `MCP conformance ${label}.arguments must be an object mapping argument names to values, got ${
        args === null ? "null" : Array.isArray(args) ? "array" : typeof args
      }`,
    );
  }
  return args;
}

/**
 * Normalize the operator's safe-to-execute fixtures.
 *
 * Names are trimmed and empty ones REJECTED rather than dropped: a fixture that
 * silently vanishes turns a fixture-gated check into a skip, and the operator
 * would read that as "the server does not support this" instead of "your config
 * has a typo".
 */
function normalizeFixtures(
  fixtures: MCPConformanceConfig["fixtures"],
): NormalizedMCPConformanceConfig["fixtures"] {
  const toolCalls = (fixtures?.toolCalls ?? []).map((entry, index) => {
    const toolName = entry.toolName?.trim();
    if (!toolName) {
      throw new Error(
        `MCP conformance fixtures.toolCalls[${index}] requires a non-empty toolName`,
      );
    }
    // Same container rule as `promptGets` below, and for the same reason: a
    // string, number, boolean or array reaching `params.arguments` is a request
    // WE malformed, and `wire-schema-valid` would report it against the server.
    //
    // Only the CONTAINER is judged here. `CallToolRequestParams.arguments` is
    // `{"type": "object", "additionalProperties": {}}` — the values are
    // arbitrary JSON, unlike a prompt's, which must be strings. Constraining
    // them would reject legitimate structured tool input.
    assertFixtureArgumentsContainer(
      entry.arguments,
      `fixtures.toolCalls[${index}]`,
    );
    return { toolName, arguments: entry.arguments };
  });

  const promptGets = (fixtures?.promptGets ?? []).map((entry, index) => {
    const promptName = entry.promptName?.trim();
    if (!promptName) {
      throw new Error(
        `MCP conformance fixtures.promptGets[${index}] requires a non-empty promptName`,
      );
    }
    // `GetPromptRequest.params.arguments` is `Record<string, string>` in every
    // revision's schema. The type says so, but this config arrives as JSON from
    // a CLI flag or the UI, where nothing enforces it. Rejecting here is the
    // difference between "your config has a number where a string goes" and a
    // `wire-schema-valid` violation reported against the SERVER for a request
    // WE malformed.
    //
    // The CONTAINER is checked before its entries, and that order is the whole
    // point: `Object.entries` does not throw on a non-object, it coerces. A
    // string spreads into index/character pairs whose values are all strings
    // (`"Ada"` → `[["0","A"], …]`), and a number or boolean yields NO entries at
    // all. Every one of those passes a values-only loop and is then forwarded
    // verbatim as `params.arguments` — exactly the malformed request this check
    // exists to prevent.
    const args = assertFixtureArgumentsContainer(
      entry.arguments,
      `fixtures.promptGets[${index}]`,
    );
    for (const [key, value] of Object.entries(args ?? {})) {
      if (typeof value !== "string") {
        throw new Error(
          `MCP conformance fixtures.promptGets[${index}].arguments.${key} must be a string (prompt arguments are Record<string, string>), got ${typeof value}`,
        );
      }
    }
    return { promptName, arguments: entry.arguments };
  });

  return { toolCalls, promptGets };
}

export function normalizeMCPConformanceConfig(
  config: MCPConformanceConfig,
): NormalizedMCPConformanceConfig {
  // A caller that forgot the field entirely must get the clear configuration
  // error below, not a `Cannot read properties of undefined (reading 'trim')`
  // TypeError recorded as the run's failure reason.
  const serverUrl =
    typeof config.serverUrl === "string" ? config.serverUrl.trim() : "";
  if (!serverUrl) {
    throw new Error("MCP conformance config requires serverUrl");
  }

  try {
    new URL(serverUrl);
  } catch {
    throw new Error(`Invalid MCP conformance serverUrl: ${serverUrl}`);
  }

  const categories = normalizeCategories(config.categories);
  const picks = resolveRetiredCheckIds(config.checkIds, config.readinessIds);
  const checkIds = normalizeCheckIds(picks.checkIds);
  const readinessIds = normalizeReadinessIds(picks.readinessIds);
  const { protocolVersion, era } = normalizeProtocolVersion(
    config.protocolVersion,
  );

  return {
    serverUrl,
    signal: config.signal,
    accessToken: config.accessToken,
    customHeaders: config.customHeaders,
    checkTimeout: config.checkTimeout ?? 30_000,
    categories,
    checkIds,
    ...(readinessIds ? { readinessIds } : {}),
    fetchFn: withAbortSignalFetch(config.fetchFn ?? fetch, config.signal),
    clientName: config.clientName?.trim() || "mcpjam-sdk-conformance",
    protocolVersion,
    era,
    inputRequiredProbe: normalizeToolProbe(
      config.inputRequiredProbe,
      "inputRequiredProbe",
    ),
    logProbe: normalizeLogProbe(config.logProbe),
    ...(config.logLevelFilteringProbe
      ? {
          logLevelFilteringProbe: normalizeLogProbe(
            config.logLevelFilteringProbe,
            "logLevelFilteringProbe"
          ),
        }
      : {}),
    fixtures: normalizeFixtures(config.fixtures),
  };
}
