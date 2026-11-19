/**
 * Rule builders shared by the core catalog files. Every rule is pure, never
 * throws, and narrows each stored value from `unknown` before reading it.
 *
 * A negative names the coverage it relies on, so the evaluator can refuse to
 * call it a gap when that part of the capture was partial or dropped. A
 * "not applicable" is only returned when the data behind it is complete;
 * otherwise the same rule returns an absent the evaluator downgrades.
 */

import { protocolEra } from "../../context.js";
import type {
  CoverageKey,
  CoverageState,
  DeclaredItem,
  DeclaredSurface,
  FeatureLifecycle,
  FeatureRuleOutcome,
  ProbeSummary,
  ProbeSurface,
  ProbeValue,
  ServerProbeId,
} from "../../types.js";
import type { CoreRevision } from "../revisions.js";

export type DeclaredRule = (surface: DeclaredSurface) => FeatureRuleOutcome;
export type ProbeRule = (probes: ProbeSurface) => FeatureRuleOutcome;

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

type PresentVia = "advertised" | "detected" | "probed" | "oauth-flow";

export function present(
  via: PresentVia,
  extra: { detail?: string; count?: number } = {}
): FeatureRuleOutcome {
  return { kind: "present", via, ...extra };
}

export function absent(
  basis: readonly CoverageKey[],
  detail?: string
): FeatureRuleOutcome {
  return detail ? { kind: "absent", basis, detail } : { kind: "absent", basis };
}

export function unknown(reason: string): FeatureRuleOutcome {
  return { kind: "unknown", reason };
}

export function notApplicable(reason: string): FeatureRuleOutcome {
  return { kind: "not-applicable", reason };
}

export function lifecycle(range: {
  introduced?: CoreRevision;
  deprecated?: CoreRevision;
  removed?: CoreRevision;
}): FeatureLifecycle {
  return { ...range };
}

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

export function isRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function hasKeys(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

/** Up to `limit` entries joined for a detail line, with a count of the rest. */
export function listDetail(values: readonly string[], limit = 4): string {
  const shown = values.slice(0, limit).join(", ");
  const rest = values.length - limit;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

// ---------------------------------------------------------------------------
// Declared surface
// ---------------------------------------------------------------------------

export function isComplete(
  surface: DeclaredSurface,
  keys: readonly CoverageKey[]
): boolean {
  return keys.every((key) => surface.coverage[key] === "complete");
}

/** Not applicable when `basis` was captured completely, else a downgradable absent. */
export function notApplicableWhenComplete(
  surface: DeclaredSurface,
  basis: readonly CoverageKey[],
  reason: string
): FeatureRuleOutcome {
  return isComplete(surface, basis) ? notApplicable(reason) : absent(basis);
}

export function surfaceEra(surface: DeclaredSurface) {
  return protocolEra(surface.protocolVersion);
}

export function capability(surface: DeclaredSurface, key: string): unknown {
  return surface.capabilities?.[key];
}

/** A server capability object, empty or not, declares the feature. */
export function declaresCapability(key: string): DeclaredRule {
  return (surface) =>
    isRecord(capability(surface, key))
      ? present("advertised")
      : absent(["capabilities"]);
}

/**
 * A capability flag that only promises later behavior (`listChanged`,
 * `subscribe`). `true` is not proof: the row waits for the notification.
 * Explicit `false` and a missing flag are both a complete "no".
 */
export function promisedFlag(
  key: string,
  flag: string,
  waitingFor: string
): DeclaredRule {
  return (surface) => {
    const value = capability(surface, key);
    if (!isRecord(value)) {
      return notApplicableWhenComplete(
        surface,
        ["capabilities"],
        `The server does not declare the ${key} capability.`
      );
    }
    if (value[flag] === true) {
      return unknown(`Declared. MCPJam has not seen ${waitingFor} yet.`);
    }
    return absent(["capabilities"]);
  };
}

type ListKey = "tools" | "resources" | "resourceTemplates" | "prompts";

const LIST_NOUN: Record<ListKey, string> = {
  tools: "tools",
  resources: "resources",
  resourceTemplates: "resource templates",
  prompts: "prompts",
};

/** Not applicable on a completely captured empty list. */
export function emptyList(
  surface: DeclaredSurface,
  key: ListKey
): FeatureRuleOutcome {
  return notApplicableWhenComplete(
    surface,
    [key],
    `The server lists no ${LIST_NOUN[key]}.`
  );
}

/** Older snapshots dropped titles and icons, so they cannot show either way. */
const OLD_SNAPSHOT =
  "Saved before MCPJam stored this field. Reconnect to capture it.";

/** The list method: present when items were listed or the list came back empty and complete. */
export function listsItems(key: ListKey, capabilityKey: string): DeclaredRule {
  return (surface) => {
    const items = surface[key];
    if (items.length > 0) {
      return present("detected", {
        count: items.length,
        detail: `${items.length} ${LIST_NOUN[key]}`,
      });
    }
    if (isRecord(capability(surface, capabilityKey))) {
      return isComplete(surface, [key])
        ? present("advertised", { count: 0, detail: "The list is empty." })
        : absent([key]);
    }
    return absent(["capabilities", key]);
  };
}

/**
 * A descriptor field on listed items: present with "n of m", absent only when
 * no item carries it, not applicable on an empty list.
 */
export function countItems(
  key: ListKey,
  test: (item: DeclaredItem) => boolean,
  basis: readonly CoverageKey[],
  options: { droppedByOldSnapshots?: boolean } = {}
): DeclaredRule {
  return (surface) => {
    const items = surface[key];
    if (items.length === 0) return emptyList(surface, key);
    if (options.droppedByOldSnapshots && surface.envelopeVersion < 3) {
      return unknown(OLD_SNAPSHOT);
    }
    const count = items.filter(test).length;
    if (count === 0) return absent(basis);
    return present("detected", {
      count,
      detail: `${count} of ${items.length} ${LIST_NOUN[key]}`,
    });
  };
}

/** A serverInfo field the server reports about itself. */
export function serverInfoField(
  test: (info: Readonly<Record<string, unknown>>) => boolean,
  options: { droppedByOldSnapshots?: boolean } = {}
): DeclaredRule {
  return (surface) => {
    if (options.droppedByOldSnapshots && surface.envelopeVersion < 3) {
      return unknown(OLD_SNAPSHOT);
    }
    const info = surface.serverInfo;
    return isRecord(info) && test(info)
      ? present("advertised")
      : absent(["serverInfo"]);
  };
}

export function annotation(item: DeclaredItem, name: string): unknown {
  const annotations = item.annotations;
  return isRecord(annotations) ? annotations[name] : undefined;
}

const MAX_SCHEMA_DEPTH = 32;

/** Depth-first search over a JSON value; bounded so a hostile schema stays cheap. */
export function someJsonNode(
  value: unknown,
  test: (node: Readonly<Record<string, unknown>>) => boolean,
  depth = 0
): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.some((entry: unknown) => someJsonNode(entry, test, depth + 1));
  }
  if (!isRecord(value)) return false;
  if (test(value)) return true;
  return Object.values(value).some((entry) =>
    someJsonNode(entry, test, depth + 1)
  );
}

/** Every string value stored under `key` anywhere in a JSON value. */
export function collectJsonStrings(value: unknown, key: string): string[] {
  const found: string[] = [];
  someJsonNode(value, (node) => {
    const entry = node[key];
    if (typeof entry === "string") found.push(entry);
    return false;
  });
  return found;
}

/** Both schemas of a tool, for rules that read either. */
export function toolSchemas(tool: DeclaredItem): unknown[] {
  return [tool.inputSchema, tool.outputSchema];
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export const STDIO_REASON =
  "Applies to HTTP servers. This server runs over stdio.";

/** HTTP-only behavior is not applicable on a stdio server. */
export const httpOnly: DeclaredRule = (surface) =>
  surface.transport === "stdio" ? notApplicable(STDIO_REASON) : null;

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

const PROBE_NOT_APPLICABLE: Record<ServerProbeId, string> = {
  "http-transport": STDIO_REASON,
  authorization: "This server does not use OAuth.",
  "server-card": "Server Cards apply to HTTP servers.",
  "apps-ui-resources": "The server has no UI resources to read.",
  skills: "The server does not offer skills.",
  "events-list": "The server does not offer events.",
};

const PROBE_LABEL: Record<ServerProbeId, string> = {
  "http-transport": "HTTP transport",
  authorization: "authorization",
  "server-card": "Server Card",
  "apps-ui-resources": "UI resource",
  skills: "skills",
  "events-list": "events",
};

/**
 * Runs `read` on a probe that finished. A missing probe says nothing; one
 * that failed or was skipped cannot answer.
 */
export function probeRule<P extends ServerProbeId>(
  id: P,
  read: (summary: ProbeSummary<P>) => FeatureRuleOutcome
): ProbeRule {
  return (probes) => {
    const summary: ProbeSummary<P> | undefined = probes[id];
    if (!summary) return null;
    if (summary.status === "not-applicable") {
      return notApplicable(PROBE_NOT_APPLICABLE[id]);
    }
    if (summary.status !== "ok") {
      return unknown(
        `The ${PROBE_LABEL[id]} probe did not finish. Refresh to try again.`
      );
    }
    return read(summary);
  };
}

/** A probe negative counts only when the probe read everything it needed. */
export function probeAbsent(
  summary: { coverage: CoverageState },
  detail?: string
): FeatureRuleOutcome {
  return summary.coverage === "complete"
    ? absent([], detail)
    : unknown("The probe could not read everything it needed.");
}

export function probeBoolean(
  value: ProbeValue | undefined
): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function probeString(value: ProbeValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function probeNumber(value: ProbeValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function probeStrings(
  value: ProbeValue | undefined
): readonly string[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Authorization leaves: not applicable when the probe saw a server that
 * answers without authorization. `read` decides everything else.
 */
export function authProbe(
  read?: (summary: ProbeSummary<"authorization">) => FeatureRuleOutcome
): ProbeRule {
  return probeRule("authorization", (summary) => {
    const required = probeBoolean(summary.values.oauthRequired);
    const optional = probeBoolean(summary.values.oauthOptional);
    if (required === false && optional !== true) {
      return notApplicable(
        "This server accepts requests without authorization."
      );
    }
    return read ? read(summary) : null;
  });
}

export const authStdio: DeclaredRule = (surface) =>
  surface.transport === "stdio"
    ? notApplicable(
        "Stdio servers take credentials from their environment, not OAuth."
      )
    : null;

/** Authorization server metadata leaves read nothing until metadata was found. */
export function asMetadataProbe(
  read: (summary: ProbeSummary<"authorization">) => FeatureRuleOutcome
): ProbeRule {
  return authProbe((summary) =>
    probeBoolean(summary.values.asMetadataFound) === true ? read(summary) : null
  );
}
