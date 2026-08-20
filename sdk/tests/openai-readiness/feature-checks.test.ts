/**
 * MCP skills, plugin UI, migration leftovers, guideline policy, and badges.
 *
 * The recurring theme: each of these lanes has a case where the WRONG answer is
 * a pass. Skills that paginate past the first page look under the cap; a second
 * UI resource sharing a `_meta.ui.domain` looks fine until two templates share
 * a sandbox; a CSP that allowlists more than it loads breaks nothing today; a
 * migrated bundle's `hooks/` directory is invisible unless something looks for
 * it; and every app-guideline that needs a human looks satisfied if you grade
 * it from a description.
 */

import { describe, expect, it } from "vitest";

import {
  runOpenAIAppsUiChecks,
  type OpenAIUiResourceEvidence,
} from "../../src/openai-readiness/checks/apps-ui.js";
import { runOpenAIMcpSkillChecks } from "../../src/openai-readiness/checks/mcp-skills.js";
import { runOpenAIMigrationChecks } from "../../src/openai-readiness/checks/migration.js";
import { runOpenAIOptionalFeatureChecks } from "../../src/openai-readiness/checks/optional-features.js";
import { runOpenAIPolicyChecks } from "../../src/openai-readiness/checks/policy.js";
import { readOpenAIPluginPackage } from "../../src/openai-readiness/package/reader.js";
import { OPENAI_MCP_SKILL_LIMITS } from "../../src/openai-readiness/profile.js";
import { parseOpenAISubmissionProfile } from "../../src/openai-readiness/submission-profile.js";
import type { OpenAISkillsEvidence } from "../../src/openai-readiness/discovery.js";
import type { OpenAIReadinessFinding } from "../../src/openai-readiness/types.js";
import {
  InMemoryOpenAIPackageSource,
  cleanSkillsPackage,
  manifestJson,
} from "./package-fixtures.js";
import { completeSubmissionProfile } from "./submission-fixtures.js";

const STAMP = { evaluatedAt: "2026-08-19T12:00:00.000Z" };

const byId = (findings: OpenAIReadinessFinding[], id: string) =>
  findings.find((finding) => finding.id === id)!;

// ------------------------------------------------------------- mcp skills

function skills(
  overrides: Partial<OpenAISkillsEvidence> = {},
): OpenAISkillsEvidence {
  return {
    extensionAdvertised: true,
    skills: [
      {
        name: "forecast",
        description: "Look up a forecast",
        declaredDigest: "abc",
        observedDigest: "abc",
        markdownBytes: 1_000,
        totalBytes: 1_000,
        frontmatter: { name: "forecast", description: "Look up a forecast" },
      },
    ],
    pagesWalked: 1,
    scannedAt: "2026-08-19T11:00:00.000Z",
    ...overrides,
  };
}

describe("mcp skills", () => {
  it("is inapplicable in a shape that does not import skills", () => {
    // Grading it would fail three valid submission shapes for not being a
    // fourth.
    for (const mode of [
      "skills-only",
      "mcp-only",
      "mcp-uploaded-skills",
    ] as const) {
      const findings = runOpenAIMcpSkillChecks({ mode }, STAMP);
      expect(
        findings.every((finding) => finding.status === "not-applicable"),
        mode,
      ).toBe(true);
    }
  });

  it("will not pass the dependent checks over a PARTIAL listing", () => {
    // A cap hit means there are skills this run never saw. "One skill, within
    // its limits, digest matching, frontmatter agreeing" is then a statement
    // about the one it read and not about the submission — and the skills
    // nobody listed are exactly where a violation would hide.
    const findings = runOpenAIMcpSkillChecks(
      {
        mode: "mcp-imported-skills",
        evidence: skills({ paginationCapHit: true, pagesWalked: 10 }),
      },
      STAMP,
    );
    expect(byId(findings, "openai.skills.listing-complete").status).toBe(
      "violated",
    );
    for (const id of [
      "openai.skills.caps",
      "openai.skills.digests",
      "openai.skills.frontmatter",
    ]) {
      expect(byId(findings, id).status, id).toBe("not-evaluated");
    }
  });

  it("treats a listing cut short by an ERROR as incomplete, not as complete", () => {
    // The page cap is only one way a walk ends early. `skills/list` erroring
    // on page two — after page one returned skills — leaves `paginationCapHit`
    // false while the listing is every bit as partial.
    const findings = runOpenAIMcpSkillChecks(
      {
        mode: "mcp-imported-skills",
        evidence: skills({
          pagesWalked: 2,
          listError: "server closed the connection",
        }),
      },
      STAMP,
    );
    const complete = byId(findings, "openai.skills.listing-complete");
    expect(complete.status).toBe("violated");
    expect(complete.remediation).toContain("server closed the connection");
    for (const id of [
      "openai.skills.caps",
      "openai.skills.digests",
      "openai.skills.frontmatter",
    ]) {
      expect(byId(findings, id).status, id).toBe("not-evaluated");
    }
  });

  it("will not size the caps check on a skill it could not fetch at all", () => {
    // A failed `skills/get` leaves `markdownBytes`, `totalBytes` AND
    // `unmeasuredPages` all absent, so the skill contributed ZERO bytes to the
    // combined total — and the caps check passed without a size measurement to
    // its name. Keying the guard off `unmeasuredPages` missed exactly this.
    const findings = runOpenAIMcpSkillChecks(
      {
        mode: "mcp-imported-skills",
        evidence: skills({
          skills: [
            skills().skills[0],
            { name: "alerts", fetchError: "skills/get returned an error" },
          ],
        }),
      },
      STAMP,
    );
    const caps = byId(findings, "openai.skills.caps");
    expect(caps.status).toBe("not-evaluated");
    expect(caps.notEvaluatedReason).toContain("alerts");
  });

  it("still reports a cap violation the fetched subset proves", () => {
    // A floor already over the limit settles the question whichever way the
    // unread skills go.
    const findings = runOpenAIMcpSkillChecks(
      {
        mode: "mcp-imported-skills",
        evidence: skills({
          listError: "server closed the connection",
          skills: Array.from({ length: 9 }, (_unused, index) => ({
            name: `skill-${index}`,
          })),
        }),
      },
      STAMP,
    );
    const caps = byId(findings, "openai.skills.caps");
    expect(caps.status).toBe("violated");
    expect(JSON.stringify(caps.details)).toContain("mcp-skill-too-many");
  });

  it("will not pass the digest check over a partly-fetched listing", () => {
    // Two skills listed, one fetched. "Every declared digest matches" is not a
    // claim one comparison supports.
    const findings = runOpenAIMcpSkillChecks(
      {
        mode: "mcp-imported-skills",
        evidence: skills({
          skills: [
            ...skills().skills,
            { name: "alerts", declaredDigest: "def" },
          ],
        }),
      },
      STAMP,
    );
    const digests = byId(findings, "openai.skills.digests");
    expect(digests.status).toBe("not-evaluated");
    expect(digests.notEvaluatedReason).toContain("alerts");
    // Frontmatter is in the same position for the same reason.
    expect(byId(findings, "openai.skills.frontmatter").status).toBe(
      "not-evaluated",
    );
  });

  it("still reports a digest mismatch that the fetched subset proves", () => {
    // Truncation only clouds the CLEAN answer. A mismatch among the skills
    // that were read settles the question whatever the unread ones say.
    const findings = runOpenAIMcpSkillChecks(
      {
        mode: "mcp-imported-skills",
        evidence: skills({
          paginationCapHit: true,
          skills: [
            {
              name: "forecast",
              declaredDigest: "abc",
              observedDigest: "not-abc",
            },
          ],
        }),
      },
      STAMP,
    );
    expect(byId(findings, "openai.skills.digests").status).toBe("violated");
  });

  it("grades the page-count limit against the DECLARED count", () => {
    // Discovery caps how many pages it reads, so `pages.length` can never
    // exceed the limit — grading against it made this check structurally
    // incapable of firing however many pages the server declared.
    const findings = runOpenAIMcpSkillChecks(
      {
        mode: "mcp-imported-skills",
        evidence: skills({
          skills: [
            {
              ...skills().skills[0],
              declaredPageCount: 40,
              pages: [{ uri: "skill://forecast/1", bytes: 10 }],
            },
          ],
        }),
      },
      STAMP,
    );
    const caps = byId(findings, "openai.skills.caps");
    expect(caps.status).toBe("violated");
    expect(JSON.stringify(caps.details)).toContain("mcp-skill-too-many-pages");
  });

  it("passes a clean single-page listing", () => {
    const findings = runOpenAIMcpSkillChecks(
      { mode: "mcp-imported-skills", evidence: skills() },
      STAMP,
    );
    for (const id of [
      "openai.skills.extension",
      "openai.skills.listing-complete",
      "openai.skills.caps",
      "openai.skills.digests",
      "openai.skills.frontmatter",
    ]) {
      expect(byId(findings, id).status, id).toBe("satisfied");
    }
  });

  it("does not treat a pagination cap as the end of the list", () => {
    // A server with six skills and a page size of five returns the sixth on
    // page two; stopping early reports five — under the cap, for a submission
    // that exceeds it.
    const findings = runOpenAIMcpSkillChecks(
      {
        mode: "mcp-imported-skills",
        evidence: skills({ paginationCapHit: true }),
      },
      STAMP,
    );
    expect(byId(findings, "openai.skills.listing-complete").status).toBe(
      "violated",
    );
  });

  it("reports each size cap against the right thing", () => {
    const findings = runOpenAIMcpSkillChecks(
      {
        mode: "mcp-imported-skills",
        evidence: skills({
          skills: [
            {
              name: "big",
              markdownBytes: OPENAI_MCP_SKILL_LIMITS.maxSkillMarkdownBytes + 1,
              totalBytes: OPENAI_MCP_SKILL_LIMITS.maxSkillTotalBytes + 1,
              pages: Array.from(
                { length: OPENAI_MCP_SKILL_LIMITS.maxPagesPerSkill + 1 },
                (_unused, index) => ({ uri: `page-${index}`, bytes: 10 }),
              ),
            },
          ],
        }),
      },
      STAMP,
    );
    const caps = byId(findings, "openai.skills.caps");
    expect(caps.status).toBe("violated");
    const codes = (caps.details?.portalIssues as { id: string }[]).map(
      (issue) => issue.id,
    );
    // Four different ceilings bounding four different things; collapsing them
    // would let a submission pass one gate while failing the one that applies.
    expect(codes).toContain("mcp-skill-markdown-too-large");
    expect(codes).toContain("mcp-skill-total-too-large");
    expect(codes).toContain("mcp-skill-too-many-pages");
  });

  it("reports a digest that does not match its resource", () => {
    const findings = runOpenAIMcpSkillChecks(
      {
        mode: "mcp-imported-skills",
        evidence: skills({
          skills: [{ name: "x", declaredDigest: "abc", observedDigest: "def" }],
        }),
      },
      STAMP,
    );
    expect(byId(findings, "openai.skills.digests").status).toBe("violated");
  });

  it("requires EXACT frontmatter agreement", () => {
    // The listing is what a user browses and the frontmatter is what the model
    // reads; two descriptions is two stories about one skill.
    const findings = runOpenAIMcpSkillChecks(
      {
        mode: "mcp-imported-skills",
        evidence: skills({
          skills: [
            {
              name: "forecast",
              description: "Look up a forecast",
              frontmatter: {
                name: "forecast",
                description: "Look up a forecast.",
              },
            },
          ],
        }),
      },
      STAMP,
    );
    expect(byId(findings, "openai.skills.frontmatter").status).toBe("violated");
  });

  it("keeps snapshot semantics a manual-review note, never a pass", () => {
    const finding = byId(
      runOpenAIMcpSkillChecks(
        { mode: "mcp-imported-skills", evidence: skills() },
        STAMP,
      ),
      "openai.skills.snapshot",
    );
    expect(finding.status).toBe("not-evaluated");
    expect(finding.class).toBe("manual-review");
  });

  it("fails the extension check when the server does not answer", () => {
    const findings = runOpenAIMcpSkillChecks(
      {
        mode: "mcp-imported-skills",
        evidence: skills({ extensionAdvertised: false, skills: [] }),
      },
      STAMP,
    );
    expect(byId(findings, "openai.skills.extension").status).toBe("violated");
    // Nothing below can be graded, and each says so rather than reporting a
    // vacuous pass over zero skills.
    expect(byId(findings, "openai.skills.caps").status).toBe("not-evaluated");
  });

  it("does not blame the submission for a listing this run never reached", () => {
    // A timeout or a 401 on this unauthenticated probe establishes nothing
    // about whether the server implements the extension. Grading it `violated`
    // — a class-`required` finding — fails a submission on a network event and
    // flips the headline verdict to not-ready.
    const findings = runOpenAIMcpSkillChecks(
      {
        mode: "mcp-imported-skills",
        evidence: skills({
          extensionAdvertised: false,
          skills: [],
          listUnreachable: true,
          listError: "readiness discovery timed out",
        }),
      },
      STAMP,
    );
    const extension = byId(findings, "openai.skills.extension");
    expect(extension.status).toBe("not-evaluated");
    expect(extension.notEvaluatedReason).toContain("timed out");
    // And nothing downstream quietly passes over the listing nobody read.
    expect(
      findings.every((finding) => finding.status === "not-evaluated"),
    ).toBe(true);
  });
});

// ------------------------------------------------------------------ ui

const uiResource = (
  overrides: Partial<OpenAIUiResourceEvidence> = {},
): OpenAIUiResourceEvidence => ({
  uri: "ui://weather/card",
  mimeType: "text/html;profile=mcp-app",
  domain: "card.weather.example.com",
  declaredCspDomains: ["cdn.weather.example.com"],
  observedDomains: ["cdn.weather.example.com"],
  ...overrides,
});

describe("plugin UI", () => {
  it("passes a conforming resource", () => {
    const findings = runOpenAIAppsUiChecks(
      { resources: [uiResource()], screenshotCount: 3 },
      STAMP,
    );
    expect(byId(findings, "openai.ui.mime").status).toBe("satisfied");
    expect(byId(findings, "openai.ui.domain-present").status).toBe("satisfied");
    expect(byId(findings, "openai.ui.domain-unique").status).toBe("satisfied");
    expect(byId(findings, "openai.ui.csp-exact").status).toBe("satisfied");
  });

  it("catches two resources sharing a ui.domain", () => {
    // The half with a security consequence: a shared domain is a shared
    // sandbox, and then one template can read the other's storage.
    const findings = runOpenAIAppsUiChecks(
      {
        resources: [uiResource(), uiResource({ uri: "ui://weather/detail" })],
      },
      STAMP,
    );
    const unique = byId(findings, "openai.ui.domain-unique");
    expect(unique.status).toBe("violated");
    expect(unique.remediation).toContain("card.weather.example.com");
  });

  it("reports a CSP that allowlists more than the template loads", () => {
    // Breaks nothing today, and is a hole nobody needed — invisible from
    // watching the template work.
    const findings = runOpenAIAppsUiChecks(
      {
        resources: [
          uiResource({
            declaredCspDomains: ["cdn.example.com", "analytics.example.net"],
            observedDomains: ["cdn.example.com"],
          }),
        ],
      },
      STAMP,
    );
    const csp = byId(findings, "openai.ui.csp-exact");
    expect(csp.status).toBe("violated");
    expect(csp.remediation).toContain("analytics.example.net");
  });

  it("reports a domain the template loads without allowlisting", () => {
    const findings = runOpenAIAppsUiChecks(
      {
        resources: [
          uiResource({
            declaredCspDomains: [],
            observedDomains: ["cdn.example.com"],
          }),
        ],
      },
      STAMP,
    );
    expect(byId(findings, "openai.ui.csp-exact").status).toBe("violated");
  });

  it("stays unevaluated on CSP when nothing was rendered", () => {
    const findings = runOpenAIAppsUiChecks(
      { resources: [uiResource({ observedDomains: undefined })] },
      STAMP,
    );
    expect(byId(findings, "openai.ui.csp-exact").status).toBe("not-evaluated");
  });

  it("cites apps-conformance for the MIME rule", () => {
    const findings = runOpenAIAppsUiChecks(
      { resources: [uiResource()] },
      STAMP,
    );
    expect(byId(findings, "openai.ui.mime").derivedFrom).toContain(
      "apps-conformance:apps-resource-mime",
    );
  });

  it("treats a plugin with no UI as inapplicable", () => {
    const findings = runOpenAIAppsUiChecks({ resources: [] }, STAMP);
    expect(byId(findings, "openai.ui.mime").status).toBe("not-applicable");
  });

  it("inverts the screenshot rule for a plugin with no UI", () => {
    // Screenshots without a template are the exclusion the portal reports.
    const findings = runOpenAIAppsUiChecks(
      { resources: [], screenshotCount: 3 },
      STAMP,
    );
    const screenshots = byId(findings, "openai.ui.screenshots");
    expect(screenshots.status).toBe("violated");
    expect((screenshots.details?.portalIssues as { id: string }[])[0].id).toBe(
      "exclusion-screenshots-without-ui",
    );
  });

  it("reports an outputSchema that does not describe the rendered data", () => {
    const findings = runOpenAIAppsUiChecks(
      {
        resources: [uiResource({ outputSchemaCoversRenderedData: false })],
      },
      STAMP,
    );
    expect(byId(findings, "openai.ui.output-schema").status).toBe("violated");
  });

  it("reports a tool that is meaningless without a UI", () => {
    const findings = runOpenAIAppsUiChecks(
      {
        resources: [
          uiResource({
            usefulWithoutUi: false,
            referencedByTools: ["show_forecast"],
          }),
        ],
      },
      STAMP,
    );
    const useful = byId(findings, "openai.ui.useful-without-ui");
    expect(useful.status).toBe("violated");
    expect(useful.remediation).toContain("show_forecast");
  });
});

// ----------------------------------------------------------------- migration

async function packageWith(files: Record<string, string | Uint8Array>) {
  return readOpenAIPluginPackage(new InMemoryOpenAIPackageSource(files));
}

describe("migration", () => {
  it("passes a package with no Claude-only surfaces", async () => {
    const findings = runOpenAIMigrationChecks(
      await packageWith(cleanSkillsPackage()),
      STAMP,
    );
    expect(byId(findings, "openai.migration.unsupported-surfaces").status).toBe(
      "satisfied",
    );
  });

  it("names every unsupported surface the package ships", async () => {
    const findings = runOpenAIMigrationChecks(
      await packageWith({
        ...cleanSkillsPackage(),
        "hooks/on-install.sh": "#!/bin/sh\n",
        "commands/do.md": "# do",
        ".app.json": "{}",
      }),
      STAMP,
    );
    const surfaces = byId(findings, "openai.migration.unsupported-surfaces");
    expect(surfaces.status).toBe("violated");
    expect(surfaces.remediation).toContain("hooks");
    expect(surfaces.remediation).toContain("commands");
    expect(surfaces.remediation).toContain("app-config");
  });

  it("does not read an UNPARSEABLE manifest as a clean one", async () => {
    // The string-scanning checks walk the parsed manifest, and a manifest that
    // is not valid JSON parses to nothing — so a naive reading visits no
    // strings, finds no placeholders, and reports both `required` checks as
    // `satisfied` on a package whose strings were never read. "Did not run"
    // reading as "conformed" is the one failure this report cannot have.
    const findings = runOpenAIMigrationChecks(
      await packageWith({
        ...cleanSkillsPackage(),
        ".codex-plugin/plugin.json": "{ this is not json",
      }),
      STAMP,
    );
    for (const id of [
      "openai.migration.user-config",
      "openai.migration.stdio-transport",
    ]) {
      const finding = byId(findings, id);
      expect(finding.status, id).toBe("not-evaluated");
      expect(finding.notEvaluatedReason, id).toContain("not readable as JSON");
    }
    // The surfaces check reads the FILE LISTING, not the manifest, so it is
    // still decidable and must not be dragged down with the other two.
    expect(byId(findings, "openai.migration.unsupported-surfaces").status).toBe(
      "satisfied",
    );
  });

  it("reports a ${user_config.*} placeholder", async () => {
    const findings = runOpenAIMigrationChecks(
      await packageWith({
        ...cleanSkillsPackage(),
        ".codex-plugin/plugin.json": manifestJson({
          mcpServers: {
            weather: {
              url: "https://weather.example.com/mcp",
              headers: { authorization: "Bearer ${user_config.api_key}" },
            },
          },
        }),
      }),
      STAMP,
    );
    expect(byId(findings, "openai.migration.user-config").status).toBe(
      "violated",
    );
  });

  it("reports a stdio command and a .mcpb reference", async () => {
    const findings = runOpenAIMigrationChecks(
      await packageWith({
        ...cleanSkillsPackage(),
        ".codex-plugin/plugin.json": manifestJson({
          mcpServers: {
            local: { command: "node", args: ["server.js"] },
          },
          bundle: "weather.mcpb",
        }),
      }),
      STAMP,
    );
    expect(byId(findings, "openai.migration.stdio-transport").status).toBe(
      "violated",
    );
  });

  it("still detects the placeholder in every spelling", async () => {
    for (const value of [
      "Bearer ${user_config.api_key}",
      "Bearer ${ user_config.api_key }",
      "prefix ${user_config.a} suffix",
    ]) {
      const findings = runOpenAIMigrationChecks(
        await packageWith({
          ...cleanSkillsPackage(),
          ".codex-plugin/plugin.json": manifestJson({ note: value }),
        }),
        STAMP,
      );
      expect(byId(findings, "openai.migration.user-config").status, value).toBe(
        "violated",
      );
    }
  });

  it("does not fire on a placeholder that never closes", async () => {
    const findings = runOpenAIMigrationChecks(
      await packageWith({
        ...cleanSkillsPackage(),
        ".codex-plugin/plugin.json": manifestJson({
          note: "${user_config.api_key",
        }),
      }),
      STAMP,
    );
    expect(byId(findings, "openai.migration.user-config").status).toBe(
      "satisfied",
    );
  });

  it("stays linear on the input that made the regex quadratic", async () => {
    // CodeQL flagged the original pattern for exactly this shape: many
    // repetitions of `${user_config.` with no closing brace. Against the
    // unanchored regex this was O(n^2); the scan that replaced it is one pass.
    // The budget is loose on purpose — it is there to catch a return to
    // quadratic behaviour, not to benchmark the machine.
    const hostile = "${user_config.".repeat(40_000);
    const started = Date.now();
    const findings = runOpenAIMigrationChecks(
      await packageWith({
        ...cleanSkillsPackage(),
        ".codex-plugin/plugin.json": manifestJson({ note: hostile }),
      }),
      STAMP,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(byId(findings, "openai.migration.user-config").status).toBe(
      "satisfied",
    );
  });

  it("keeps host-name language a non-dispositive note", async () => {
    // The word "Claude" in a description is not by itself a defect, and failing
    // on a string match is exactly the false positive that teaches people to
    // ignore a report.
    const findings = runOpenAIMigrationChecks(
      await packageWith({
        ...cleanSkillsPackage(),
        ".codex-plugin/plugin.json": manifestJson({
          description: "A weather plugin for Claude Code.",
        }),
      }),
      STAMP,
    );
    const language = byId(findings, "openai.migration.host-language");
    expect(language.status).toBe("informational");
    expect(language.class).toBe("heuristic");
    expect(language.lane).toBe("experience-insights");
  });
});

// ------------------------------------------------------------------- policy

const profileFor = (overrides: Record<string, unknown> = {}) =>
  parseOpenAISubmissionProfile(completeSubmissionProfile(overrides as never))
    .profile;

describe("app guidelines", () => {
  it("passes descriptive listing copy", () => {
    const findings = runOpenAIPolicyChecks({ profile: profileFor() }, STAMP);
    expect(byId(findings, "openai.policy.non-promotional-listing").status).toBe(
      "satisfied",
    );
  });

  it("catches a ranking claim and names the field", () => {
    const findings = runOpenAIPolicyChecks(
      {
        profile: profileFor({
          description: "The #1 weather plugin, guaranteed accurate.",
        }),
      },
      STAMP,
    );
    const promo = byId(findings, "openai.policy.non-promotional-listing");
    expect(promo.status).toBe("violated");
    expect(promo.remediation).toContain("listing.description");
  });

  it("does not fail ordinary product copy", () => {
    // A sentiment judgement here would fail most real descriptions; the rule is
    // about specific claims.
    const findings = runOpenAIPolicyChecks(
      {
        profile: profileFor({
          description:
            "Fast, accurate forecasts for any city, with alerts and history.",
        }),
      },
      STAMP,
    );
    expect(byId(findings, "openai.policy.non-promotional-listing").status).toBe(
      "satisfied",
    );
  });

  // This check is `required`, so every phrase on the list is a submission it
  // can block. Ordinary commerce copy using the same words is the expensive
  // false positive, and each of these is a sentence a reviewer would wave
  // through.
  for (const copy of [
    "Includes a 30-day money-back guarantee on every subscription.",
    "Guaranteed delivery by Friday for orders placed before noon.",
    "Ships to #10 Downing Street and 4,100 other addresses.",
    "Track the best route between any two stations.",
    // `#1` bound to nothing is an issue reference, not a rank claim, and this
    // check is `required` — blocking a submission on a changelog line is the
    // same false positive as blocking one on a money-back guarantee.
    "Fixes issue #1 and closes #1 in the tracker.",
  ]) {
    it(`does not read "${copy.slice(0, 32)}…" as a promotional claim`, () => {
      const findings = runOpenAIPolicyChecks(
        { profile: profileFor({ description: copy }) },
        STAMP,
      );
      expect(
        byId(findings, "openai.policy.non-promotional-listing").status,
      ).toBe("satisfied");
    });
  }

  // …and the claims it must still catch, including the one spelling of a rank
  // that anybody actually writes. `\b#` demands a word character before the
  // hash, so the pattern that used to be here matched `app#1` and never
  // `The #1 plugin`.
  for (const copy of [
    "The #1 weather plugin for ChatGPT.",
    "#1 rated forecast tool.",
    "Guaranteed results or your money back.",
    "100% guaranteed savings on every trip.",
  ]) {
    it(`reads "${copy.slice(0, 32)}…" as a promotional claim`, () => {
      const findings = runOpenAIPolicyChecks(
        { profile: profileFor({ description: copy }) },
        STAMP,
      );
      expect(
        byId(findings, "openai.policy.non-promotional-listing").status,
      ).toBe("violated");
    });
  }

  it("grades package copy separately, in the technical lane", () => {
    // The two copies live in different artifacts: a package's description is
    // available to a preflight, and a listing's only exists once someone starts
    // filling in the form.
    const findings = runOpenAIPolicyChecks(
      {
        packageMetadata: [
          { field: "manifest.description", text: "The world's best plugin." },
        ],
      },
      STAMP,
    );
    const pkg = byId(findings, "openai.policy.non-promotional-package");
    expect(pkg.status).toBe("violated");
    expect(pkg.lane).toBe("directory-policy");
    // And the listing half stays a named gap rather than dragging the
    // technical lane down with it.
    const listing = byId(findings, "openai.policy.non-promotional-listing");
    expect(listing.status).toBe("not-evaluated");
    expect(listing.lane).toBe("submission-artifacts");
  });

  it("treats a run with no package as inapplicable for package copy", () => {
    // An MCP-only submission has no package copy, and asking for one would be
    // asking for something that shape does not have.
    const findings = runOpenAIPolicyChecks({ profile: profileFor() }, STAMP);
    expect(byId(findings, "openai.policy.non-promotional-package").status).toBe(
      "not-applicable",
    );
  });

  it("keeps every judgement call manual and in experience-insights", () => {
    const findings = runOpenAIPolicyChecks({ profile: profileFor() }, STAMP);
    for (const id of [
      "openai.policy.no-advertising",
      "openai.policy.originality",
      "openai.policy.predictable-side-effects",
      "openai.policy.response-minimization",
      "openai.policy.privacy-consistency",
    ]) {
      const finding = byId(findings, id);
      expect(finding.status, id).toBe("not-evaluated");
      expect(finding.class, id).toBe("manual-review");
      expect(finding.lane, id).toBe("experience-insights");
      // Each names WHAT to look at; "a human has to look" with no object is a
      // shrug rather than a task.
      expect(finding.notEvaluatedReason!.length, id).toBeGreaterThan(40);
    }
  });

  it("does not attach the commerce rules to a plugin that sells nothing", () => {
    expect(
      byId(
        runOpenAIPolicyChecks(
          { profile: profileFor(), hasCommerce: false },
          STAMP,
        ),
        "openai.policy.commerce",
      ).status,
    ).toBe("not-applicable");
  });

  it("reports the commerce rules as beyond this run when it does sell", () => {
    expect(
      byId(
        runOpenAIPolicyChecks(
          { profile: profileFor(), hasCommerce: true },
          STAMP,
        ),
        "openai.policy.commerce",
      ).status,
    ).toBe("not-evaluated");
  });
});

// ------------------------------------------------------------------- badges

describe("badges", () => {
  it("can never fail a lane, whatever the state", () => {
    const { findings, badges } = runOpenAIOptionalFeatureChecks(
      {
        importedSkills: false,
        uiResourceCount: 0,
        clientIdMetadataDocuments: false,
        checkout: false,
      },
      STAMP,
    );
    // Two independent guards: a class the dispositive predicate excludes, and a
    // lane no stage rolls up.
    for (const finding of findings) {
      expect(finding.class).toBe("experimental-feature");
      expect(finding.lane).toBe("optional-features");
      expect(finding.status).toBe("informational");
    }
    expect(badges.every((badge) => badge.state === "unsupported")).toBe(true);
  });

  it("separates 'observed absent' from 'never looked'", () => {
    const { badges } = runOpenAIOptionalFeatureChecks({}, STAMP);
    // Collapsing these would report a capability as missing when nobody checked.
    expect(badges.every((badge) => badge.state === "not-evaluated")).toBe(true);
  });

  it("marks an observed capability supported", () => {
    const { badges } = runOpenAIOptionalFeatureChecks(
      { importedSkills: true, uiResourceCount: 2 },
      STAMP,
    );
    expect(
      badges.find((badge) => badge.id === "openai.feature.imported-skills")
        ?.state,
    ).toBe("supported");
    expect(
      badges.find((badge) => badge.id === "openai.feature.ui-templates")?.state,
    ).toBe("supported");
  });
});
