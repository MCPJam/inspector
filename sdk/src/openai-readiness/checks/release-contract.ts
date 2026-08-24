/**
 * The release-contract lane: what changed since the published version, and what
 * that costs.
 *
 * THREE OUTCOMES, and telling them apart is the entire value of this lane:
 *
 *   - LIVE-COMPATIBLE — UI content behind an unchanged URI, or a server-side fix
 *     that preserves the contract. Ships without review; the host may serve a
 *     cached copy for up to an hour, which is worth saying because "I deployed
 *     it and nothing changed" is otherwise a bug report.
 *   - RESCAN-REQUIRED — a tool, schema, annotation, security scheme, `_meta`
 *     entry, `instructions` string, UI URI or CSP moved. The draft has to be
 *     rescanned and re-reviewed.
 *   - NEW-PLUGIN-REQUIRED — the server's ORIGIN moved. Not a version at all: a
 *     different origin is a different plugin, and a submitter who files it as an
 *     update loses the review and starts over.
 *
 * A path change is an ordinary version bump, which is why the snapshot stores
 * origin and path apart.
 *
 * WHERE THE HONESTY LIVES. Schema comparison. Whether a changed JSON Schema is
 * COMPATIBLE — a widened enum, a new optional field — is a real question with a
 * real answer, and structural equality cannot give it. So a changed schema is
 * `manual-review`, never an automatic fail: reporting "not ready" for an added
 * optional property would be wrong in the direction that costs a submitter a
 * release, and reporting "ready" for a removed required one would be wrong in
 * the direction that breaks users. Neither is acceptable, so the check reports
 * what moved and says a person must decide.
 *
 * FIRST SUBMISSIONS have no published side and the lane is `not-applicable` —
 * there is no contract to break.
 *
 * Pure data. No transport.
 */

import { openaiPolicySource } from "../manifest.js";
import { OPENAI_RELEASE_RULES } from "../profile.js";
import {
  OPENAI_READINESS_INPUTS,
  type OpenAIReadinessFinding,
} from "../types.js";
import type {
  OpenAIMetadataSnapshot,
  OpenAIToolSnapshot,
  OpenAIUiResourceSnapshot,
} from "../snapshot.js";
import {
  informational,
  missingInput,
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type OpenAICheckDefinition,
  type OpenAICheckStamp,
} from "./helpers.js";

/** What a single change costs. */
export type OpenAIReleaseImpact =
  | "live-compatible"
  | "rescan-required"
  | "new-plugin-required"
  | "unknown-compatibility";

export interface OpenAIReleaseDelta {
  impact: OpenAIReleaseImpact;
  /** What moved, e.g. `tools.get_forecast.inputSchema`. */
  subject: string;
  detail: string;
}

const ORIGIN_STABLE: OpenAICheckDefinition = {
  id: "openai.release.origin",
  title: "The MCP server's origin is unchanged",
  lane: "release-contract",
  class: "required",
  source: openaiPolicySource("deploy/submission", "§Updating a plugin"),
  provenance: "wire",
  intrusiveness: "passive",
};

const CONTRACT_STABLE: OpenAICheckDefinition = {
  id: "openai.release.contract",
  title: "No contract-breaking change requires a rescan",
  lane: "release-contract",
  class: "required",
  source: openaiPolicySource("deploy/submission", "§Scan tools"),
  provenance: "wire",
  intrusiveness: "passive",
};

const SCHEMA_COMPATIBILITY: OpenAICheckDefinition = {
  id: "openai.release.schema-compatibility",
  title: "Changed schemas remain compatible with the published version",
  lane: "release-contract",
  class: "manual-review",
  source: openaiPolicySource("deploy/submission", "§Updating a plugin"),
  provenance: "wire",
  intrusiveness: "passive",
};

const LIVE_CHANGES: OpenAICheckDefinition = {
  id: "openai.release.live-changes",
  title: "Changes that ship without a review",
  lane: "release-contract",
  class: "experimental-feature",
  source: openaiPolicySource("deploy/submission", "§Updating a plugin"),
  provenance: "wire",
  intrusiveness: "passive",
};

const ALL: OpenAICheckDefinition[] = [
  ORIGIN_STABLE,
  CONTRACT_STABLE,
  SCHEMA_COMPATIBILITY,
  LIVE_CHANGES,
];

export interface OpenAIReleaseContractInput {
  draft?: OpenAIMetadataSnapshot;
  published?: OpenAIMetadataSnapshot;
  /** Whether a version is published at all. */
  hasPublishedVersion?: boolean;
}

/** Structural equality over the parts of a value a contract is about. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  // Canonical JSON: key ORDER is not contract, and two scans of one server may
  // serialize an object either way.
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

function toolsByName(
  snapshot: OpenAIMetadataSnapshot,
): Map<string, OpenAIToolSnapshot> {
  return new Map(snapshot.tools.map((tool) => [tool.name, tool]));
}

function resourcesByUri(
  snapshot: OpenAIMetadataSnapshot,
): Map<string, OpenAIUiResourceSnapshot> {
  return new Map(
    snapshot.uiResources.map((resource) => [resource.uri, resource]),
  );
}

/**
 * Every difference between the two snapshots, classified.
 *
 * Exported because the delta list is what a surface renders: a submitter wants
 * to see WHAT changed, and a lane status alone does not tell them.
 */
export function compareOpenAISnapshots(
  published: OpenAIMetadataSnapshot,
  draft: OpenAIMetadataSnapshot,
): OpenAIReleaseDelta[] {
  const deltas: OpenAIReleaseDelta[] = [];

  if (published.origin !== draft.origin) {
    deltas.push({
      impact: "new-plugin-required",
      subject: "server.origin",
      detail: `the origin moved from ${published.origin} to ${draft.origin}; a different origin is a different plugin, not a new version`,
    });
  }

  // A PATH change is an ordinary version bump. Reporting it as an origin change
  // would tell a submitter to start over for a routine move.
  if (published.path !== draft.path) {
    deltas.push({
      impact: "rescan-required",
      subject: "server.path",
      detail: `the endpoint path moved from ${published.path || "/"} to ${draft.path || "/"}`,
    });
  }

  if (!sameValue(published.instructions, draft.instructions)) {
    deltas.push({
      impact: "rescan-required",
      subject: "server.instructions",
      detail: "the server's instructions changed, and the model reads them",
    });
  }

  const publishedTools = toolsByName(published);
  const draftTools = toolsByName(draft);

  for (const [name, tool] of draftTools) {
    if (!publishedTools.has(name)) {
      deltas.push({
        impact: "rescan-required",
        subject: `tools.${name}`,
        detail: "a tool was added",
      });
      continue;
    }
    const before = publishedTools.get(name)!;

    for (const field of ["title", "description"] as const) {
      if (!sameValue(before[field], tool[field])) {
        deltas.push({
          impact: "rescan-required",
          subject: `tools.${name}.${field}`,
          detail: `the tool's ${field} changed`,
        });
      }
    }

    for (const field of ["inputSchema", "outputSchema"] as const) {
      if (!sameValue(before[field], tool[field])) {
        // NOT a fail. Whether a widened enum or an added optional field is
        // compatible is a real question with a real answer, and structural
        // equality does not have it.
        deltas.push({
          impact: "unknown-compatibility",
          subject: `tools.${name}.${field}`,
          detail: `the tool's ${field} changed; whether the change is backward-compatible needs a person`,
        });
      }
    }

    for (const field of ["annotations", "securitySchemes", "meta"] as const) {
      if (!sameValue(before[field], tool[field])) {
        deltas.push({
          impact: "rescan-required",
          subject: `tools.${name}.${field}`,
          detail: `the tool's ${field} changed`,
        });
      }
    }
  }

  for (const name of publishedTools.keys()) {
    if (!draftTools.has(name)) {
      deltas.push({
        impact: "rescan-required",
        subject: `tools.${name}`,
        detail: "a published tool was removed",
      });
    }
  }

  const publishedResources = resourcesByUri(published);
  const draftResources = resourcesByUri(draft);

  for (const [uri, resource] of draftResources) {
    if (!publishedResources.has(uri)) {
      deltas.push({
        impact: "rescan-required",
        subject: `ui.${uri}`,
        detail: "a UI resource was added at a new URI",
      });
      continue;
    }
    const before = publishedResources.get(uri)!;
    for (const field of ["mimeType", "domain"] as const) {
      if (!sameValue(before[field], resource[field])) {
        deltas.push({
          impact: "rescan-required",
          subject: `ui.${uri}.${field}`,
          detail: `the resource's ${field} changed`,
        });
      }
    }
    if (!sameValue(before.cspDomains, resource.cspDomains)) {
      deltas.push({
        impact: "rescan-required",
        subject: `ui.${uri}.cspDomains`,
        detail: "the resource's content security policy changed",
      });
    }
  }

  for (const uri of publishedResources.keys()) {
    if (!draftResources.has(uri)) {
      deltas.push({
        impact: "rescan-required",
        subject: `ui.${uri}`,
        detail: "a published UI resource was removed",
      });
    }
  }

  // Every URI that survived unchanged in its metadata: whatever the template
  // SERVES from it may change without a review, and saying so is what stops a
  // submitter filing a version for a CSS fix.
  const unchanged = [...draftResources.keys()].filter(
    (uri) =>
      publishedResources.has(uri) &&
      !deltas.some((delta) => delta.subject.startsWith(`ui.${uri}.`)),
  );
  for (const uri of unchanged) {
    deltas.push({
      impact: "live-compatible",
      subject: `ui.${uri}`,
      detail: `content served from this URI may change without a review; the host may serve a cached copy for up to ${OPENAI_RELEASE_RULES.uiContentCacheSeconds / 60} minutes`,
    });
  }

  return deltas;
}

export function runOpenAIReleaseContractChecks(
  input: OpenAIReleaseContractInput,
  stamp: OpenAICheckStamp,
): OpenAIReadinessFinding[] {
  // A first submission has no contract to break. `not-applicable`, not
  // `incomplete`: nothing was left unverified.
  if (!input.hasPublishedVersion) {
    return ALL.map((definition) =>
      notApplicable(
        definition,
        stamp,
        "no version of this plugin is published, so there is no contract for this one to break",
      ),
    );
  }

  const missing: string[] = [];
  if (!input.published) missing.push(OPENAI_READINESS_INPUTS.publishedSnapshot);
  if (!input.draft) missing.push(OPENAI_READINESS_INPUTS.draftSnapshot);

  if (missing.length > 0) {
    return ALL.map((definition) =>
      notEvaluated(
        definition,
        stamp,
        `a published version exists and this run has no ${missing.join(" and no ")} to compare`,
        missingInput(missing[0], { alsoMissing: missing.slice(1) }),
      ),
    );
  }

  const deltas = compareOpenAISnapshots(input.published!, input.draft!);
  const findings: OpenAIReadinessFinding[] = [];

  const originMoved = deltas.filter(
    (delta) => delta.impact === "new-plugin-required",
  );
  findings.push(
    originMoved.length === 0
      ? satisfied(ORIGIN_STABLE, stamp, { origin: input.draft!.origin })
      : violated(
          ORIGIN_STABLE,
          stamp,
          // The one outcome a submitter must not discover late: filing this as
          // an update loses the review and starts over.
          `${originMoved[0].detail}. Submit this as a new plugin rather than as a version of the published one.`,
          { deltas: originMoved },
        ),
  );

  const rescan = deltas.filter((delta) => delta.impact === "rescan-required");
  findings.push(
    rescan.length === 0
      ? satisfied(CONTRACT_STABLE, stamp, { deltas: [] })
      : violated(
          CONTRACT_STABLE,
          stamp,
          `${rescan.length} contract change(s) require a fresh Scan Tools and a new review: ${rescan
            .map((delta) => delta.subject)
            .join(", ")}.`,
          { deltas: rescan },
        ),
  );

  const unknown = deltas.filter(
    (delta) => delta.impact === "unknown-compatibility",
  );
  findings.push(
    unknown.length === 0
      ? satisfied(SCHEMA_COMPATIBILITY, stamp, { changed: [] })
      : notEvaluated(
          SCHEMA_COMPATIBILITY,
          stamp,
          // Never an automatic fail. An added optional property and a removed
          // required one are both "the schema changed", and getting either
          // verdict wrong costs a submitter a release or breaks their users.
          `${unknown.length} schema(s) changed; whether each change is backward-compatible is a judgement this run cannot make: ${unknown
            .map((delta) => delta.subject)
            .join(", ")}`,
          { deltas: unknown },
        ),
  );

  const live = deltas.filter((delta) => delta.impact === "live-compatible");
  findings.push(
    informational(
      LIVE_CHANGES,
      stamp,
      { deltas: live },
      live.length === 0
        ? "No UI resource survived unchanged, so nothing here ships without a review."
        : `${live.length} UI resource(s) may change their served content without a review; the host may serve a cached copy for up to ${OPENAI_RELEASE_RULES.uiContentCacheSeconds / 60} minutes.`,
    ),
  );

  return findings;
}
