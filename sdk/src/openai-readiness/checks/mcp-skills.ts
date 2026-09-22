/**
 * Checks over skills imported from the MCP server.
 *
 * THE SNAPSHOT SEMANTICS ARE THE POINT. Imported skills are a SUBMISSION-TIME
 * COPY: the portal reads them when the submitter runs Scan Tools and stores
 * what it read. A skill that changes on the server afterwards does not change
 * the submission, and it does not "drift" in any sense this lane can grade —
 * whether the DRAFT still matches the PUBLISHED contract is the
 * release-contract lane's question, against two snapshots, not this one's
 * against a live server.
 *
 * So everything here grades one scan: the extension answered, the listing
 * paginated to the end, the sizes and counts are under the caps, each digest
 * matches the resource it names, and the listing metadata agrees EXACTLY with
 * the frontmatter of the markdown it points at.
 *
 * WHEN THE LANE APPLIES. Only in `mcp-imported-skills`. In the other three
 * shapes the absence of imported skills is a BADGE — a capability the
 * submission does not use — and grading it as a defect would fail three
 * perfectly valid submission shapes for not being a fourth.
 *
 * Pure data. No transport.
 */

import { openaiPolicySource } from "../manifest.js";
import { OPENAI_MCP_SKILL_LIMITS } from "../profile.js";
import { openaiPortalIssue, type OpenAIPortalIssue } from "../portal-errors.js";
import { checkFrontmatterDrift } from "../../mcp-client-manager/skills-integrity.js";
import {
  OPENAI_READINESS_INPUTS,
  OPENAI_SUBMISSION_MODE_SHAPES,
  type OpenAIReadinessFinding,
  type OpenAISubmissionMode,
} from "../types.js";
import type { OpenAISkillsEvidence } from "../discovery.js";
import {
  missingInput,
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type OpenAICheckDefinition,
  type OpenAICheckStamp,
} from "./helpers.js";

const EXTENSION_ADVERTISED: OpenAICheckDefinition = {
  id: "openai.skills.extension",
  title: "The server advertises the skills extension",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("build/skills", "§Importing from MCP"),
  provenance: "wire",
};

const LISTING_COMPLETE: OpenAICheckDefinition = {
  id: "openai.skills.listing-complete",
  title: "The skills listing was read to the end of its pagination",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("build/skills", "§Importing from MCP"),
  provenance: "wire",
};

const WITHIN_CAPS: OpenAICheckDefinition = {
  id: "openai.skills.caps",
  title: "Imported skills are within the count and size caps",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("deploy/submission-errors", "§Skills"),
  provenance: "wire",
};

const DIGESTS_MATCH: OpenAICheckDefinition = {
  id: "openai.skills.digests",
  title: "Each skill's declared digest matches the resource it names",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("build/skills", "§Importing from MCP"),
  provenance: "wire",
};

const FRONTMATTER_AGREES: OpenAICheckDefinition = {
  id: "openai.skills.frontmatter",
  title: "Listing metadata agrees exactly with each skill's frontmatter",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("build/skills", "§Importing from MCP"),
  provenance: "wire",
};

const SNAPSHOT_SEMANTICS: OpenAICheckDefinition = {
  id: "openai.skills.snapshot",
  title: "Imported skills are a scan-time snapshot, not a live resource",
  lane: "experience-insights",
  class: "manual-review",
  source: openaiPolicySource("deploy/submission", "§Scan tools"),
  provenance: "wire",
};

const ALL: OpenAICheckDefinition[] = [
  EXTENSION_ADVERTISED,
  LISTING_COMPLETE,
  WITHIN_CAPS,
  DIGESTS_MATCH,
  FRONTMATTER_AGREES,
  SNAPSHOT_SEMANTICS,
];

function comparableDigest(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // `lower` in BOTH branches. Returning the original in the fallback meant a
  // server declaring a bare uppercase hex digest never matched the
  // always-lowercase `observedDigest`, and was reported as a mismatch for a
  // difference in case alone.
  const lower = value.toLowerCase();
  return lower.startsWith("sha256:") ? lower.slice("sha256:".length) : lower;
}

export interface OpenAISkillsCheckInput {
  mode: OpenAISubmissionMode;
  evidence?: OpenAISkillsEvidence;
}

export function runOpenAIMcpSkillChecks(
  input: OpenAISkillsCheckInput,
  stamp: OpenAICheckStamp,
): OpenAIReadinessFinding[] {
  const shape = OPENAI_SUBMISSION_MODE_SHAPES[input.mode];

  // Only dispositive in the shape that IMPORTS skills. Elsewhere their absence
  // is a capability the submission does not use, reported as a badge.
  if (!shape.hasImportedSkills) {
    return ALL.map((definition) =>
      notApplicable(
        definition,
        stamp,
        `a ${input.mode} submission does not import skills from the server`,
      ),
    );
  }

  if (!input.evidence) {
    return ALL.map((definition) =>
      notEvaluated(
        definition,
        stamp,
        "this run read no skills listing from the server",
        missingInput(OPENAI_READINESS_INPUTS.importedSkills),
      ),
    );
  }

  const evidence = input.evidence;
  const findings: OpenAIReadinessFinding[] = [];
  const issues: OpenAIPortalIssue[] = [];

  if (!evidence.extensionAdvertised) {
    // REACHED AND REFUSED, or never reached at all. Only the first is the
    // submission's fault. A timeout or a 401 on this unauthenticated probe says
    // nothing about whether the server implements the extension, and grading it
    // `violated` — a class-`required` finding — would fail a submission on the
    // strength of a network event.
    if (evidence.listUnreachable) {
      return ALL.map((definition) =>
        notEvaluated(
          definition,
          stamp,
          `this run could not read a skills listing from the server: ${
            evidence.listError ?? "the request produced no readable answer"
          }`,
        ),
      );
    }

    findings.push(
      violated(
        EXTENSION_ADVERTISED,
        stamp,
        "This submission imports skills from the server, and the server does not answer `skills/list`.",
        { listError: evidence.listError },
      ),
    );
    // Nothing below can be graded without a listing, and each says so rather
    // than reporting a vacuous pass over zero skills.
    for (const definition of [
      LISTING_COMPLETE,
      WITHIN_CAPS,
      DIGESTS_MATCH,
      FRONTMATTER_AGREES,
      SNAPSHOT_SEMANTICS,
    ]) {
      findings.push(
        notEvaluated(
          definition,
          stamp,
          "the server advertised no skills extension, so there was no listing to grade",
        ),
      );
    }
    return findings;
  }

  findings.push(
    satisfied(EXTENSION_ADVERTISED, stamp, { skills: evidence.skills.length }),
  );

  // TWO WAYS A LISTING ENDS EARLY, and only one of them is the page cap. The
  // walk also stops when `skills/list` ERRORS — and an error on page two,
  // after page one returned skills, leaves `paginationCapHit` false while the
  // listing is every bit as incomplete. Reaching this line means page one
  // succeeded (`extensionAdvertised` is true), so a `listError` here is always
  // the mid-walk case.
  const listingCutShort =
    evidence.paginationCapHit === true || evidence.listError !== undefined;

  // A cap hit is NOT the end of the list. Treating it as one would report a
  // count under the limit for a server that has more.
  findings.push(
    listingCutShort
      ? violated(
          LISTING_COMPLETE,
          stamp,
          evidence.listError !== undefined
            ? `The skills listing stopped part-way with an error, so this run has not seen every skill: ${evidence.listError}`
            : "The skills listing was still paginating at the page limit, so this run has not seen every skill.",
          { pagesWalked: evidence.pagesWalked, listError: evidence.listError },
        )
      : satisfied(LISTING_COMPLETE, stamp, {
          pagesWalked: evidence.pagesWalked,
        }),
  );

  // A PARTIAL LISTING MAKES EVERY CLEAN RESULT BELOW PROVISIONAL. There are
  // skills this run never saw, so "five skills, all within their limits, all
  // digests matching" is a statement about the five it read and not about the
  // submission. Violations are unaffected — a limit already exceeded by what
  // WAS read stays exceeded however many more there are.
  const partialListing = listingCutShort;
  const partialListingReason =
    evidence.listError !== undefined
      ? `the skills listing stopped part-way after ${evidence.pagesWalked} page(s) with an error, so this run has not seen every skill: ${evidence.listError}`
      : `the skills listing was still paginating at the page limit after ` +
        `${evidence.pagesWalked} page(s), so this run has not seen every skill`;

  // ------------------------------------------------------------------- caps
  if (evidence.skills.length > OPENAI_MCP_SKILL_LIMITS.maxSkills) {
    issues.push(
      openaiPortalIssue("mcp-skill-too-many", {
        observed: evidence.skills.length,
        expected: OPENAI_MCP_SKILL_LIMITS.maxSkills,
      }),
    );
  }

  let combinedBytes = 0;
  const unmeasured: string[] = [];
  for (const skill of evidence.skills) {
    const subject = skill.name ?? skill.resourceUri ?? "(unnamed skill)";
    if (
      skill.markdownBytes !== undefined &&
      skill.markdownBytes > OPENAI_MCP_SKILL_LIMITS.maxSkillMarkdownBytes
    ) {
      issues.push(
        openaiPortalIssue("mcp-skill-markdown-too-large", {
          subject,
          observed: skill.markdownBytes,
          expected: OPENAI_MCP_SKILL_LIMITS.maxSkillMarkdownBytes,
        }),
      );
    }
    for (const page of skill.pages ?? []) {
      if (page.bytes > OPENAI_MCP_SKILL_LIMITS.maxPageBytes) {
        issues.push(
          openaiPortalIssue("mcp-skill-page-too-large", {
            subject: `${subject} → ${page.uri}`,
            observed: page.bytes,
            expected: OPENAI_MCP_SKILL_LIMITS.maxPageBytes,
          }),
        );
      }
    }
    // THE DECLARED COUNT, not the fetched one. Discovery caps how many pages it
    // will read, so `pages.length` can never exceed the limit — grading against
    // it would make this check structurally incapable of firing.
    const pageCount = skill.declaredPageCount ?? skill.pages?.length ?? 0;
    if (pageCount > OPENAI_MCP_SKILL_LIMITS.maxPagesPerSkill) {
      issues.push(
        openaiPortalIssue("mcp-skill-too-many-pages", {
          subject,
          observed: pageCount,
          expected: OPENAI_MCP_SKILL_LIMITS.maxPagesPerSkill,
        }),
      );
    }
    if (
      skill.totalBytes !== undefined &&
      skill.totalBytes > OPENAI_MCP_SKILL_LIMITS.maxSkillTotalBytes
    ) {
      issues.push(
        openaiPortalIssue("mcp-skill-total-too-large", {
          subject,
          observed: skill.totalBytes,
          expected: OPENAI_MCP_SKILL_LIMITS.maxSkillTotalBytes,
        }),
      );
    }
    combinedBytes += skill.totalBytes ?? skill.markdownBytes ?? 0;
    // `totalBytes` ABSENT IS THE WHOLE TEST, whatever made it absent. Two
    // different failures land here and both understate the line above: a skill
    // whose pages could not all be sized adds its markdown alone, and a skill
    // whose `skills/get` failed outright adds ZERO — it has no `markdownBytes`
    // either. The earlier version keyed off `unmeasuredPages`, which a failed
    // fetch never sets, so an unfetchable skill contributed nothing and the
    // caps check passed without a size measurement to its name.
    if (skill.totalBytes === undefined) {
      unmeasured.push(skill.name ?? skill.resourceUri ?? "(unnamed skill)");
    }
  }

  if (combinedBytes > OPENAI_MCP_SKILL_LIMITS.maxImportedTotalBytes) {
    issues.push(
      openaiPortalIssue("mcp-skills-total-too-large", {
        observed: combinedBytes,
        expected: OPENAI_MCP_SKILL_LIMITS.maxImportedTotalBytes,
      }),
    );
  }

  findings.push(
    issues.length === 0
      ? // A LIMIT NOBODY MEASURED IS NOT A LIMIT ANYBODY MET. When a skill's
        // pages could not all be sized, `combinedBytes` is a floor, and a
        // submission over the cap would sit under it — so the honest answer is
        // that this run could not decide, not that the caps were respected.
        // Confirmed violations above are unaffected: a floor already over the
        // limit settles the question whichever way the missing pages go.
        partialListing || unmeasured.length > 0
        ? notEvaluated(
            WITHIN_CAPS,
            stamp,
            partialListing
              ? partialListingReason
              : `these skills have no total size this run could establish, so the combined figure is a floor rather than a measurement: ${unmeasured.join(", ")}`,
          )
        : satisfied(WITHIN_CAPS, stamp, {
            skills: evidence.skills.length,
            combinedBytes,
            portalIssues: [],
          })
      : violated(
          WITHIN_CAPS,
          stamp,
          `${issues.length} imported-skill limit(s) exceeded.`,
          { portalIssues: issues, combinedBytes },
        ),
  );

  // ---------------------------------------------------------------- digests
  const unfetched = evidence.skills.filter(
    (skill) => skill.observedDigest === undefined,
  );
  const mismatched = evidence.skills.filter(
    (skill) =>
      skill.declaredDigest !== undefined &&
      skill.observedDigest !== undefined &&
      comparableDigest(skill.declaredDigest) !==
        comparableDigest(skill.observedDigest),
  );

  findings.push(
    mismatched.length > 0
      ? violated(
          DIGESTS_MATCH,
          stamp,
          `These skills declare a digest that does not match the resource they name: ${mismatched
            .map((skill) => skill.name ?? skill.resourceUri)
            .join(", ")}.`,
          {
            portalIssues: mismatched.map((skill) =>
              openaiPortalIssue("mcp-skill-digest-mismatch", {
                subject: skill.name ?? skill.resourceUri,
              }),
            ),
          },
        )
      : // ANY unfetched skill, not only all of them. "Every declared digest
        // matches", said over the three skills that were read when five were
        // listed, is not the claim the check's title makes — and the two
        // skills nobody fetched are exactly where a mismatch would hide.
        partialListing || (unfetched.length > 0 && evidence.skills.length > 0)
        ? notEvaluated(
            DIGESTS_MATCH,
            stamp,
            partialListing
              ? partialListingReason
              : unfetched.length === evidence.skills.length
                ? "no skill resource was fetched, so no declared digest could be compared against its content"
                : `${unfetched.length} of ${evidence.skills.length} skill resources were not fetched, so their declared digests were never compared: ${unfetched
                    .map(
                      (skill) => skill.name ?? skill.resourceUri ?? "(unnamed)",
                    )
                    .join(", ")}`,
          )
        : satisfied(DIGESTS_MATCH, stamp, {
            compared: evidence.skills.length - unfetched.length,
          }),
  );

  // ------------------------------------------------------------ frontmatter
  //
  // EXACT agreement, not "close enough". The listing is what a user browses and
  // the frontmatter is what the model reads, and a plugin whose two descriptions
  // differ is telling two different stories about the same skill.
  const disagreeing = evidence.skills.filter((skill) => {
    if (!skill.frontmatter) return false;
    if (skill.declaredFrontmatter) {
      return !checkFrontmatterDrift(
        skill.declaredFrontmatter,
        skill.frontmatter,
      ).ok;
    }
    const name = skill.frontmatter.name;
    const description = skill.frontmatter.description;
    return (
      (typeof name === "string" &&
        skill.name !== undefined &&
        name !== skill.name) ||
      (typeof description === "string" &&
        skill.description !== undefined &&
        description !== skill.description)
    );
  });
  const withFrontmatter = evidence.skills.filter((skill) => skill.frontmatter);

  findings.push(
    disagreeing.length > 0
      ? violated(
          FRONTMATTER_AGREES,
          stamp,
          `These skills' listing metadata disagrees with their SKILL.md frontmatter: ${disagreeing
            .map((skill) => skill.name ?? skill.resourceUri)
            .join(", ")}.`,
          {
            portalIssues: disagreeing.map((skill) =>
              openaiPortalIssue("mcp-skill-frontmatter-mismatch", {
                subject: skill.name ?? skill.resourceUri,
              }),
            ),
          },
        )
      : // As for digests: a clean comparison over the subset that was read is
        // not a clean comparison over the submission.
        partialListing ||
          (withFrontmatter.length < evidence.skills.length &&
            evidence.skills.length > 0)
        ? notEvaluated(
            FRONTMATTER_AGREES,
            stamp,
            partialListing
              ? partialListingReason
              : withFrontmatter.length === 0
                ? "no skill's markdown was fetched, so its frontmatter could not be compared with the listing"
                : `${evidence.skills.length - withFrontmatter.length} of ${evidence.skills.length} skills' markdown was not fetched, so their frontmatter was never compared with the listing`,
          )
        : satisfied(FRONTMATTER_AGREES, stamp, {
            compared: withFrontmatter.length,
          }),
  );

  // -------------------------------------------------------------- the snapshot
  findings.push(
    notEvaluated(
      SNAPSHOT_SEMANTICS,
      stamp,
      "imported skills are copied at scan time, so what the portal holds is whatever the last Scan Tools read — this run cannot tell whether that scan is the one that was submitted",
      { scannedAt: evidence.scannedAt, skills: evidence.skills.length },
    ),
  );

  return findings;
}
