/**
 * Plugin-package checks.
 *
 * TWO LAYERS, DELIBERATELY. The reader already produced a list of typed portal
 * issues — one per documented code, with the subject and the observed value.
 * This module does NOT re-derive them. It groups them into a handful of
 * findings a person can read, and carries every original code through in
 * `details.portalIssues`.
 *
 * That split is the whole design. A finding per portal code produces forty
 * findings for one bad archive and nobody reads the fortieth; one finding with
 * the codes collapsed away loses the thing an auditor needs. Grouping is
 * PRESENTATION, and the data underneath it is lossless.
 *
 * WHAT DECIDES APPLICABILITY. The submission mode, never the presence of a
 * bundle. An mcp-only submission has no archive, so these findings are
 * `not-applicable` — nothing was left unverified. A mode that DOES upload an
 * archive but was handed no bundle gets `not-evaluated` naming `pluginBundle`.
 * Those two must never look alike.
 *
 * Pure data. No transport.
 */

import { openaiPolicySource } from "../manifest.js";
import {
  groupPortalIssues,
  openaiPortalIssue,
  type OpenAIPortalErrorCategory,
  type OpenAIPortalIssue,
} from "../portal-errors.js";
import type { OpenAIPluginPackageEvidence } from "../package/reader.js";
import {
  OPENAI_READINESS_INPUTS,
  OPENAI_SUBMISSION_MODE_SHAPES,
  type OpenAIReadinessFinding,
  type OpenAISubmissionMode,
} from "../types.js";
import {
  missingInput,
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type OpenAICheckDefinition,
  type OpenAICheckStamp,
} from "./helpers.js";

export interface OpenAIPackageEvidenceInput {
  mode: OpenAISubmissionMode;
  /** Absent when the caller supplied no package. */
  package?: OpenAIPluginPackageEvidence;
}

/**
 * One finding per portal-error CATEGORY.
 *
 * The categories come from the published error list, so the grouping a reader
 * sees is the publisher's own taxonomy rather than one invented here.
 */
const CATEGORY_CHECKS: Record<
  OpenAIPortalErrorCategory,
  OpenAICheckDefinition | undefined
> = {
  "package-archive": {
    id: "openai.package.archive",
    title: "The package archive satisfies the portal's size and path rules",
    lane: "plugin-package",
    class: "required",
    source: openaiPolicySource(
      "deploy/submission-errors",
      "§Shared package checks",
    ),
    provenance: "static",
    intrusiveness: "passive",
  },
  "package-manifest": {
    id: "openai.package.manifest",
    title: "The plugin manifest and OpenAI interface document are valid",
    lane: "plugin-package",
    class: "required",
    source: openaiPolicySource("build/plugins", "§Manifest"),
    provenance: "static",
    intrusiveness: "passive",
  },
  "package-skills": {
    id: "openai.package.skills",
    title: "Every packaged skill has valid metadata and a unique name",
    lane: "plugin-package",
    class: "required",
    source: openaiPolicySource("build/skills", "§Skill structure"),
    provenance: "static",
    intrusiveness: "passive",
  },
  "package-assets": {
    id: "openai.package.assets",
    title: "Packaged images meet the format, size and dimension rules",
    lane: "plugin-package",
    class: "required",
    source: openaiPolicySource("deploy/submission-errors", "§Images"),
    provenance: "static",
    intrusiveness: "passive",
  },
  exclusions: {
    id: "openai.package.exclusions",
    title: "The package contains nothing this submission shape excludes",
    lane: "plugin-package",
    class: "required",
    source: openaiPolicySource(
      "deploy/submission-errors",
      "§Shared package checks → Excluded content",
    ),
    provenance: "static",
    intrusiveness: "passive",
  },
  // Categories that belong to other lanes. Listed explicitly rather than
  // omitted so a new category cannot be silently dropped: the record is total
  // over the category union, and adding one to the union without deciding
  // where it belongs stops this file compiling.
  "listing-fields": undefined,
  "mcp-server": undefined,
  "mcp-skills": undefined,
  "review-materials": undefined,
};

/** The categories this lane grades, in the order a reader wants them. */
const PACKAGE_CATEGORIES: OpenAIPortalErrorCategory[] = [
  "package-archive",
  "package-manifest",
  "package-skills",
  "package-assets",
  "exclusions",
];

/**
 * Content the submission SHAPE excludes, as opposed to content that is simply
 * wrong.
 *
 * A skills-only package declaring MCP servers is not a broken package — it is a
 * package submitted in the wrong shape, and the portal has its own codes for
 * exactly that. Deriving these from the declared mode rather than from what
 * happens to be present is what makes the distinction possible: with inference,
 * a bundle that declares servers simply WOULD be an MCP submission, and there
 * would be nothing to report.
 */
function exclusionIssues(
  mode: OpenAISubmissionMode,
  evidence: OpenAIPluginPackageEvidence,
): OpenAIPortalIssue[] {
  const shape = OPENAI_SUBMISSION_MODE_SHAPES[mode];
  const issues: OpenAIPortalIssue[] = [];

  if (
    !shape.hasMcpServer &&
    (evidence.manifest?.mcpServerNames.length ?? 0) > 0
  ) {
    issues.push(
      openaiPortalIssue("exclusion-mcp-servers-in-skills-only", {
        subject: evidence.manifest?.location.path,
        observed: evidence.manifest?.mcpServerNames.join(", "),
      }),
    );
  }

  if (!shape.hasUploadedPackage) {
    issues.push(
      openaiPortalIssue("exclusion-bundle-in-mcp-only", {
        observed: `${evidence.entryStats.fileCount} file(s)`,
      }),
    );
  }

  for (const surface of evidence.surfaces) {
    issues.push(
      openaiPortalIssue(
        surface.surface === "app-config"
          ? "exclusion-app-config-in-public-package"
          : "exclusion-unsupported-surface",
        { subject: surface.path, observed: surface.surface },
      ),
    );
  }

  return issues;
}

/**
 * One line naming what tripped, without listing forty codes.
 *
 * Leads with the count and the first two subjects — enough to recognise the
 * problem — and leaves the full list to `details.portalIssues`, where it is
 * complete.
 */
function summarizeIssues(issues: OpenAIPortalIssue[]): string {
  const subjects = issues
    .map((issue) => issue.subject)
    .filter((subject): subject is string => Boolean(subject));
  const named = [...new Set(subjects)].slice(0, 2);
  const suffix = named.length > 0 ? ` (${named.join(", ")}…)` : "";
  return issues.length === 1
    ? `${issues[0].message}${suffix}`
    : `${issues.length} package problems the portal reports${suffix}`;
}

export function runOpenAIPackageChecks(
  evidence: OpenAIPackageEvidenceInput,
  stamp: OpenAICheckStamp,
): OpenAIReadinessFinding[] {
  const shape = OPENAI_SUBMISSION_MODE_SHAPES[evidence.mode];
  const findings: OpenAIReadinessFinding[] = [];

  for (const category of PACKAGE_CATEGORIES) {
    const definition = CATEGORY_CHECKS[category];
    if (!definition) continue;

    // The mode has no archive at all. Nothing was left unverified, so this is
    // `not-applicable` and NOT a coverage gap — the distinction the explicit
    // submission mode exists to make.
    if (!shape.hasUploadedPackage && category !== "exclusions") {
      findings.push(
        notApplicable(
          definition,
          stamp,
          `the ${evidence.mode} mode is ${shape.summary}, so there is no package archive to grade`,
        ),
      );
      continue;
    }

    // EXCLUSIONS IS THE ONE CATEGORY A PACKAGE-LESS MODE STILL ANSWERS, and
    // the answer is that it passed. The rule it grades is "an mcp-only
    // submission does not upload a bundle", so a run with no bundle has
    // observed the rule being kept rather than failed to look — and falling
    // through to the clause below would print "uploads a package and none was
    // supplied", which contradicts the mode in the same sentence.
    if (!shape.hasUploadedPackage && !evidence.package) {
      findings.push(
        satisfied(definition, stamp, {
          portalIssues: [],
          examined: `the ${evidence.mode} mode is ${shape.summary}, and no package was uploaded`,
        }),
      );
      continue;
    }

    if (!evidence.package) {
      findings.push(
        notEvaluated(
          definition,
          stamp,
          `the ${evidence.mode} mode uploads a package and none was supplied to this run`,
          missingInput(OPENAI_READINESS_INPUTS.pluginBundle),
        ),
      );
      continue;
    }

    const all =
      category === "exclusions"
        ? exclusionIssues(evidence.mode, evidence.package)
        : (groupPortalIssues(evidence.package.issues).get(category) ?? []);

    if (all.length === 0) {
      findings.push(
        satisfied(definition, stamp, {
          portalIssues: [],
          // The denominator, so "no issues" is legible as "we looked".
          examined: describeExamined(category, evidence.package),
        }),
      );
      continue;
    }

    findings.push(
      violated(definition, stamp, summarizeIssues(all), {
        // EVERY code, never a summary of them. The finding text is for a
        // reader; this is for whoever has to fix each one.
        portalIssues: all,
        examined: describeExamined(category, evidence.package),
      }),
    );
  }

  // What the reader could not look at becomes its own coverage statement
  // rather than disappearing into a passing archive finding.
  if (shape.hasUploadedPackage && evidence.package) {
    for (const gap of evidence.package.gaps) {
      findings.push(
        notEvaluated(
          {
            id: `openai.package.observation.${gap.subject}`,
            title: `Archive observation: ${gap.subject}`,
            lane: "plugin-package",
            class: "required",
            source: openaiPolicySource(
              "deploy/submission-errors",
              "§Shared package checks",
            ),
            provenance: "static",
            intrusiveness: "passive",
          },
          stamp,
          gap.reason,
          missingInput(OPENAI_READINESS_INPUTS.pluginBundle, {
            observation: gap.subject,
          }),
        ),
      );
    }

    // A non-canonical manifest location is not a violation — the portal accepts
    // it — but it IS an assumption this run made, and a submitter should hear
    // that their package works because we normalised it.
    const location = evidence.package.manifest?.location;
    if (location && !location.canonical) {
      findings.push(
        satisfied(
          {
            id: "openai.package.manifest-location",
            title: "The plugin manifest is in an accepted location",
            lane: "plugin-package",
            class: "recommended",
            source: openaiPolicySource("build/plugins", "§Package layout"),
            provenance: "static",
            intrusiveness: "passive",
          },
          stamp,
          {
            assumed: `read from ${location.path} and treated as ${OPENAI_MANIFEST_CANONICAL}`,
            canonical: OPENAI_MANIFEST_CANONICAL,
          },
        ),
      );
    }
  }

  return findings;
}

const OPENAI_MANIFEST_CANONICAL = ".codex-plugin/plugin.json";

/** What the category actually looked at, so a pass has a denominator. */
function describeExamined(
  category: OpenAIPortalErrorCategory,
  evidence: OpenAIPluginPackageEvidence,
): Record<string, unknown> {
  switch (category) {
    case "package-archive":
      return {
        entries: evidence.entryStats.entryCount,
        files: evidence.entryStats.fileCount,
        uncompressedBytes: evidence.entryStats.totalUncompressedBytes,
        compressedBytes: evidence.entryStats.compressedBytes,
      };
    case "package-manifest":
      return { manifestPath: evidence.manifest?.location.path };
    case "package-skills":
      return { skills: evidence.skills.map((skill) => skill.directory) };
    case "package-assets":
      return { assets: evidence.assets.map((asset) => asset.path) };
    default:
      return { surfaces: evidence.surfaces.map((surface) => surface.path) };
  }
}
