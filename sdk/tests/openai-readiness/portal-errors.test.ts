/**
 * The portal-error catalog's load-bearing invariants.
 *
 * The catalog is the transcription of a published error list, and the one way
 * it can rot quietly is by disagreeing with the constants the checks actually
 * enforce. A catalog entry saying "max 5000 entries" while `profile.ts` allows
 * 6000 does not fail anything — it just tells a submitter the wrong number in
 * the one place they will read it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  OPENAI_PORTAL_ERRORS,
  OPENAI_PORTAL_ERRORS_BY_ID,
  OPENAI_PORTAL_ERROR_CATEGORIES,
  groupPortalIssues,
  hasBlockingPortalIssue,
  openaiPortalIssue,
} from "../../src/openai-readiness/portal-errors.js";
import { OPENAI_HOST_PROFILE } from "../../src/openai-readiness/profile.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ERRORS_SOURCE = join(
  here,
  "../../src/openai-readiness/portal-errors.ts",
);

/** Resolve a dotted `profile.ts` path like `archiveLimits.maxEntries`. */
function readProfileConstant(path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) => (value as Record<string, unknown>)?.[key],
      OPENAI_HOST_PROFILE as unknown,
    );
}

describe("catalog integrity", () => {
  it("has a unique id for every entry", () => {
    const ids = OPENAI_PORTAL_ERRORS.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("indexes every entry by id", () => {
    expect(Object.keys(OPENAI_PORTAL_ERRORS_BY_ID)).toHaveLength(
      OPENAI_PORTAL_ERRORS.length,
    );
  });

  it("uses only declared categories", () => {
    for (const definition of OPENAI_PORTAL_ERRORS) {
      expect(OPENAI_PORTAL_ERROR_CATEGORIES).toContain(definition.category);
    }
  });

  it("cites the submission-errors page on every entry", () => {
    // The catalog IS the transcription of that page. An entry citing something
    // else is either misfiled or invented, and both are worth failing on.
    for (const definition of OPENAI_PORTAL_ERRORS) {
      expect(definition.source.page).toBe("deploy/submission-errors");
      expect(definition.source.section.length).toBeGreaterThan(0);
    }
  });

  it("gives every entry a message that reads as a sentence", () => {
    for (const definition of OPENAI_PORTAL_ERRORS) {
      expect(definition.message.length).toBeGreaterThan(10);
      expect(definition.message.endsWith(".")).toBe(true);
    }
  });
});

describe("catalog limits agree with the host profile", () => {
  it("resolves every named limit to the identical profile constant", () => {
    const withLimits = OPENAI_PORTAL_ERRORS.filter(
      (definition) => definition.limit,
    );
    // Guards the guard: if the catalog ever stops carrying limits, this test
    // would pass vacuously and stop protecting anything.
    expect(withLimits.length).toBeGreaterThan(5);

    for (const definition of withLimits) {
      const limit = definition.limit!;
      expect(
        readProfileConstant(limit.name),
        `${definition.id} cites ${limit.name}`,
      ).toBe(limit.value);
    }
  });

  it("restates no limit as a bare literal in the catalog source", () => {
    // The correspondence above only holds while the catalog REFERENCES the
    // profile. A hand-typed `value: 5000` would satisfy it on the day it was
    // written and silently diverge on the day the profile changed, so the
    // source itself is checked for numeric literals in `limit` positions.
    const source = readFileSync(PORTAL_ERRORS_SOURCE, "utf8");
    const literals = [...source.matchAll(/value:\s*([0-9][0-9_]*)\b/g)].map(
      (match) => match[1],
    );
    expect(literals).toEqual([]);
  });

  it("keeps every profile limit reachable from some catalog entry", () => {
    // Not every constant needs an error code, but the numeric ceilings do:
    // a limit the catalog cannot name is a limit a submitter is graded against
    // and never told about.
    const cited = new Set(
      OPENAI_PORTAL_ERRORS.flatMap((definition) =>
        definition.limit ? [definition.limit.name] : [],
      ),
    );
    for (const name of [
      "archiveLimits.maxCompressedBytes",
      "archiveLimits.maxUncompressedBytes",
      "archiveLimits.maxEntries",
      "imageConstraints.maxBytes",
      "imageConstraints.minEdgePx",
      "imageConstraints.maxEdgePx",
      "mcpSkillLimits.maxSkills",
      "mcpSkillLimits.maxSkillMarkdownBytes",
      "mcpSkillLimits.maxPageBytes",
      "mcpSkillLimits.maxSkillTotalBytes",
      "mcpSkillLimits.maxImportedTotalBytes",
      "mcpSkillLimits.maxPagesPerSkill",
      "submissionTestCases.successCount",
      "submissionTestCases.failureCount",
    ]) {
      expect(cited, `${name} has no error code`).toContain(name);
    }
  });
});

describe("openaiPortalIssue", () => {
  it("copies the catalog's category, severity and message", () => {
    const issue = openaiPortalIssue("archive-too-many-entries", {
      subject: "package.zip",
      observed: 6_000,
      expected: OPENAI_HOST_PROFILE.archiveLimits.maxEntries,
    });
    expect(issue).toEqual({
      id: "archive-too-many-entries",
      category: "package-archive",
      severity: "blocking",
      message: OPENAI_PORTAL_ERRORS_BY_ID["archive-too-many-entries"].message,
      subject: "package.zip",
      observed: 6_000,
      expected: 5_000,
    });
  });

  it("throws on an id the catalog does not define", () => {
    // A check raising an undocumented code is a bug in the check, and the
    // loudest failure is the cheapest one to fix. Silently minting an entry
    // would break the invariant that every reported code is a documented one.
    expect(() => openaiPortalIssue("no-such-code")).toThrow(
      /Unknown OpenAI portal error id/,
    );
  });
});

describe("grouping is presentation only", () => {
  it("preserves every issue when grouped", () => {
    const issues = [
      openaiPortalIssue("archive-too-large"),
      openaiPortalIssue("archive-symlink-entry"),
      openaiPortalIssue("manifest-missing"),
    ];
    const grouped = groupPortalIssues(issues);
    expect([...grouped.values()].flat()).toHaveLength(issues.length);
    expect(grouped.get("package-archive")).toHaveLength(2);
    expect(grouped.get("package-manifest")).toHaveLength(1);
  });

  it("reports a blocking issue among advisories", () => {
    expect(
      hasBlockingPortalIssue([
        openaiPortalIssue("review-annotation-justification-missing"),
      ]),
    ).toBe(false);
    expect(
      hasBlockingPortalIssue([
        openaiPortalIssue("review-annotation-justification-missing"),
        openaiPortalIssue("manifest-missing"),
      ]),
    ).toBe(true);
  });
});
