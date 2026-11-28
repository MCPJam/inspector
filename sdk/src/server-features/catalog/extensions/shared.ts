/**
 * Helpers shared by the extension catalog files (families 18–24): pinned spec
 * links, wire readers that treat every value as `unknown`, and the common
 * outcomes for extension declarations and probe summaries.
 */

import { protocolEra } from "../../context.js";
import type {
  CoverageKey,
  DeclaredItem,
  DeclaredSurface,
  FeatureDefinition,
  FeatureFamilyId,
  FeatureRuleOutcome,
  FeatureSpecRef,
  FeatureSpecSource,
  ProbeStatus,
  ProbeValue,
} from "../../types.js";
import { externalSpec } from "../spec-refs.js";

// ---------------------------------------------------------------------------
// Spec links, pinned to the commits in SPEC_PINS
// ---------------------------------------------------------------------------

const GITHUB = "https://github.com";
const APPS_REPO = `${GITHUB}/modelcontextprotocol/ext-apps/blob/ea3e9d0e624a20bc1c51310292f09d9b8ed17161/specification`;
const AUTH_REPO = `${GITHUB}/modelcontextprotocol/ext-auth/blob/15ca394e00a66434520b9ade26294999295a43ae/specification/stable`;
const SERVER_CARD_REPO = `${GITHUB}/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93`;

const SPEC_DOCUMENTS = {
  apps: `${APPS_REPO}/2026-01-26/apps.mdx`,
  "apps-draft": `${APPS_REPO}/draft/apps.mdx`,
  tasks: `${GITHUB}/modelcontextprotocol/ext-tasks/blob/cc9aaac1047a9440b07486e38f37060bbebeef4c/specification/2026-07-28/tasks.md`,
  skills: `${GITHUB}/modelcontextprotocol/ext-skills/blob/649f7aee87d631ac4d1fdd3b12eef0c6264fdb3a/specification/beta/skills.mdx`,
  events: `${GITHUB}/modelcontextprotocol/ext-events/blob/47d95c979faa73427e1f6e0ac0c1347559d8ea37/docs/design-sketch-proposal.md`,
  "client-credentials": `${AUTH_REPO}/oauth-client-credentials/2026-07-28/oauth-client-credentials.mdx`,
  "enterprise-managed-authorization": `${AUTH_REPO}/enterprise-managed-authorization/2026-07-28/enterprise-managed-authorization.mdx`,
  "server-card-discovery": `${SERVER_CARD_REPO}/docs/discovery.md`,
  "server-card-schema": `${SERVER_CARD_REPO}/schema.ts`,
  openai: `${GITHUB}/openai/mcp-extensions/blob/39f91ad0bdf1435aadb879172ab2467d0e97cead/docs/spec.md`,
} as const;

const DOCUMENT_SOURCES = {
  apps: "ext-apps",
  "apps-draft": "ext-apps",
  tasks: "ext-tasks",
  skills: "ext-skills",
  events: "ext-events",
  "client-credentials": "ext-auth",
  "enterprise-managed-authorization": "ext-auth",
  "server-card-discovery": "ext-server-card",
  "server-card-schema": "ext-server-card",
  openai: "openai-mcp-extensions",
} as const satisfies Record<keyof typeof SPEC_DOCUMENTS, FeatureSpecSource>;

/** A pinned extension document, optionally at a heading anchor. */
export function specAt(
  document: keyof typeof SPEC_DOCUMENTS,
  anchor?: string
): FeatureSpecRef {
  const url = `${SPEC_DOCUMENTS[document]}${anchor ? `#${anchor}` : ""}`;
  return externalSpec(DOCUMENT_SOURCES[document], url);
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

type FeatureInput = Omit<
  FeatureDefinition,
  "family" | "owner" | "stage" | "lifecycle" | "optional"
> &
  Partial<
    Pick<FeatureDefinition, "owner" | "stage" | "lifecycle" | "optional">
  >;

/**
 * A definition factory for one family. Defaults: owned by the server,
 * optional, no core lifecycle, and the family's stage.
 */
export function familyFeature(
  family: FeatureFamilyId,
  stage: FeatureDefinition["stage"]
) {
  return (input: FeatureInput): FeatureDefinition => ({
    family,
    owner: "server",
    stage,
    lifecycle: {},
    optional: true,
    ...input,
  });
}

// ---------------------------------------------------------------------------
// Wire readers
// ---------------------------------------------------------------------------

export type WireRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is WireRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordAt(value: unknown, key: string): WireRecord | undefined {
  if (!isRecord(value)) return undefined;
  const entry = value[key];
  return isRecord(entry) ? entry : undefined;
}

export function stringAt(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const entry = value[key];
  return typeof entry === "string" ? entry : undefined;
}

export function metaOf(item: DeclaredItem): WireRecord | undefined {
  return recordAt(item, "_meta");
}

export function capabilitiesOf(
  surface: DeclaredSurface
): WireRecord | undefined {
  return isRecord(surface.capabilities) ? surface.capabilities : undefined;
}

export function isComplete(
  surface: DeclaredSurface,
  keys: readonly CoverageKey[]
): boolean {
  return keys.every((key) => surface.coverage[key] === "complete");
}

/** "3 of 12 tools", for `detail`. */
export function countOf(count: number, total: number, noun: string): string {
  return `${count} of ${total} ${noun}`;
}

// ---------------------------------------------------------------------------
// Extension declarations
// ---------------------------------------------------------------------------

export type ExtensionLookup =
  | { state: "declared"; settings: WireRecord; location: string }
  | { state: "malformed"; location: string }
  | { state: "not-declared" }
  | { state: "not-captured" };

/**
 * Reads an extension's settings object. The map is `{ [id]: settings }`, so
 * a value that is not an object (`true`, `[]`, `null`) is malformed and does
 * not count as a declaration, as in `tasks-dispatch` and `skills-dispatch`.
 */
export function lookupExtension(
  surface: DeclaredSurface,
  id: string,
  containers: readonly ("extensions" | "experimental")[] = ["extensions"]
): ExtensionLookup {
  const capabilities = capabilitiesOf(surface);
  if (!capabilities) return { state: "not-captured" };
  for (const container of containers) {
    const map = recordAt(capabilities, container);
    if (!map || !Object.prototype.hasOwnProperty.call(map, id)) continue;
    const location = `${container}["${id}"]`;
    const settings = map[id];
    return isRecord(settings)
      ? { state: "declared", settings, location }
      : { state: "malformed", location };
  }
  return { state: "not-declared" };
}

/**
 * Outcome for an extension declared under `capabilities.extensions`. On
 * 2026-07-28 a missing id is a real absence. Earlier revisions carry
 * `extensions` only unofficially, so a missing id there proves nothing, and
 * an unknown revision never borrows the current rules.
 */
export function extensionOutcome(
  surface: DeclaredSurface,
  id: string,
  label: string,
  containers?: readonly ("extensions" | "experimental")[]
): FeatureRuleOutcome {
  const lookup = lookupExtension(surface, id, containers);
  switch (lookup.state) {
    case "declared":
      return { kind: "present", via: "advertised", detail: lookup.location };
    case "malformed":
      return {
        kind: "unknown",
        reason: `${label} is declared with a value that is not an object, so clients ignore it.`,
      };
    case "not-captured":
      return {
        kind: "unknown",
        reason: "The server's capabilities were not captured.",
      };
    case "not-declared":
      return missingExtensionOutcome(surface);
  }
}

/** A missing extension id: absent on the modern revision, unknown otherwise. */
export function missingExtensionOutcome(
  surface: DeclaredSurface
): FeatureRuleOutcome {
  const era = protocolEra(surface.protocolVersion);
  if (era === "modern") return { kind: "absent", basis: ["capabilities"] };
  if (era === "legacy") {
    return {
      kind: "unknown",
      reason: `Version ${surface.protocolVersion} has no official extensions field, so a missing declaration proves nothing.`,
    };
  }
  return {
    kind: "unknown",
    reason:
      "The protocol version of this capture is unknown, so a missing declaration proves nothing.",
  };
}

/**
 * For a sub-feature of `parent`: not applicable when the parent is known to
 * be absent (every basis key captured completely), otherwise no claim.
 */
export function unlessParentAbsent(
  surface: DeclaredSurface,
  parent: FeatureRuleOutcome,
  reason: string
): FeatureRuleOutcome {
  if (parent?.kind === "absent" && isComplete(surface, parent.basis)) {
    return { kind: "not-applicable", reason };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Probe summaries
// ---------------------------------------------------------------------------

export function probeBoolean(
  value: ProbeValue | undefined
): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function probeNumber(value: ProbeValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function probeString(value: ProbeValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function probeStrings(
  value: ProbeValue | undefined
): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

interface ProbeHeader {
  status: ProbeStatus;
  detail?: string;
}

const PROBE_STATUS_REASONS: Record<
  Exclude<ProbeStatus, "ok" | "not-applicable">,
  string
> = {
  failed: "did not finish. Refresh to try again.",
  skipped: "was skipped for this connection.",
  abandoned: "stopped because the server asked for input.",
};

/**
 * What a rule returns when the probe cannot answer: `null` when it never
 * ran, `not-applicable` when the probe says so, `unknown` for any status
 * other than `ok`. `undefined` means the probe ran and its values can be read.
 */
export function probeBlocker(
  probe: ProbeHeader | undefined,
  label: string
): FeatureRuleOutcome | undefined {
  if (!probe) return null;
  if (probe.status === "ok") return undefined;
  if (probe.status === "not-applicable") {
    return {
      kind: "not-applicable",
      reason: `The ${label} check does not apply to this server.`,
    };
  }
  return {
    kind: "unknown",
    reason: `The ${label} check ${PROBE_STATUS_REASONS[probe.status]}`,
  };
}
