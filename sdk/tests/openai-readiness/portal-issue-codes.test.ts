/**
 * MCPJam's own OpenAI issue ids and check ids, matched to the portal's codes,
 * and the codes on the results a run reports.
 */

import { describe, expect, it } from "vitest";

import { violated } from "../../src/openai-readiness/checks/helpers.js";
import { runOpenAIPackageChecks } from "../../src/openai-readiness/checks/package.js";
import { openaiPolicySource } from "../../src/openai-readiness/manifest.js";
import { readOpenAIPluginPackage } from "../../src/openai-readiness/package/reader.js";
import {
  OPENAI_CHECK_PORTAL_CODES,
  OPENAI_ISSUE_PORTAL_CODES,
  openaiIssuePortalCode,
  withPortalCode,
} from "../../src/openai-readiness/portal-codes/issue-codes.js";
import {
  OPENAI_PORTAL_CODES_BY_CODE,
  isOpenAIPortalCode,
} from "../../src/openai-readiness/portal-codes/table.js";
import {
  OPENAI_PORTAL_ERRORS,
  openaiPortalIssue,
} from "../../src/openai-readiness/portal-errors.js";
import { gradeOpenAIReadiness } from "../../src/openai-readiness/runner.js";
import type { OpenAIReadinessFinding } from "../../src/openai-readiness/types.js";
import {
  CANONICAL_MANIFEST_PATH,
  InMemoryOpenAIPackageSource,
  archiveObservations,
  cleanSkillsPackage,
  manifestJson,
  nonSquarePng,
} from "./package-fixtures.js";

const MCPJAM_IDS = OPENAI_PORTAL_ERRORS.map((entry) => entry.id).filter(
  (id) => !isOpenAIPortalCode(id)
);

describe("MCPJam's issue ids", () => {
  it("are the 81 the catalog defines, each matched or marked unmatched", () => {
    expect(MCPJAM_IDS).toHaveLength(81);
    expect(Object.keys(OPENAI_ISSUE_PORTAL_CODES).sort()).toEqual(
      [...MCPJAM_IDS].sort()
    );
    for (const code of Object.values(OPENAI_ISSUE_PORTAL_CODES)) {
      if (code !== null) expect(isOpenAIPortalCode(code), code).toBe(true);
    }
  });

  it("leave these 39 without a portal code", () => {
    const unmatched = MCPJAM_IDS.filter(
      (id) => OPENAI_ISSUE_PORTAL_CODES[id] === null
    );
    expect(unmatched).toEqual([
      "archive-path-control-character",
      "interface-display-name-too-long",
      "interface-short-description-too-long",
      "interface-default-prompt-too-long",
      "interface-brand-color-low-contrast",
      "interface-unsupported-text",
      "listing-promotional-metadata",
      "listing-privacy-policy-missing",
      "listing-support-url-missing",
      "mcp-endpoint-not-https",
      "mcp-endpoint-unreachable",
      "mcp-tool-name-too-long",
      "mcp-tool-description-missing",
      "mcp-tool-schema-invalid",
      "mcp-csp-domain-missing",
      "mcp-ui-domain-missing",
      "mcp-ui-domain-duplicate",
      "mcp-ui-mime-invalid",
      "mcp-skill-too-many",
      "mcp-skill-markdown-too-large",
      "mcp-skill-page-too-large",
      "mcp-skill-too-many-pages",
      "mcp-skill-total-too-large",
      "mcp-skills-total-too-large",
      "mcp-skill-digest-mismatch",
      "mcp-skill-frontmatter-mismatch",
      "mcp-skill-scan-failed",
      "review-success-tests-missing",
      "review-failure-tests-missing",
      "review-demo-credentials-missing",
      "review-demo-recording-missing",
      "review-release-notes-missing",
      "review-attestation-missing",
      "review-identity-not-verified",
      "review-write-permission-missing",
      "review-geography-missing",
      "exclusion-screenshots-without-ui",
      "exclusion-bundle-in-mcp-only",
      "exclusion-unsupported-surface",
    ]);
  });

  it("match a code in the same family as the id", () => {
    // A cheap guard against a mapping pasted onto the wrong line.
    const families: Record<string, RegExp> = {
      archive: /^archive_/,
      manifest: /^plugin_(manifest|name|version)_/,
      interface: /^skill_agent_/,
      skill: /^skill_/,
      asset: /^(image_|raster_|svg_|declared_asset_)/,
      listing: /^(plugin_category_|submission_description_)/,
      mcp: /^(annotations|domain_verification)_required$/,
      review: /^(justification|scan)_required$/,
      exclusion: /^(mcp|app)_configuration_excluded$/,
    };
    for (const [id, code] of Object.entries(OPENAI_ISSUE_PORTAL_CODES)) {
      if (code === null) continue;
      const family = id.split("-")[0];
      expect(code, id).toMatch(families[family]);
    }
  });

  it("put the code on each issue they raise", () => {
    expect(openaiPortalIssue("archive-symlink-entry").portalCode).toBe(
      "archive_member_type_unsupported"
    );
    expect(openaiPortalIssue("plugin_name_format").portalCode).toBe(
      "plugin_name_format"
    );
    expect(
      openaiPortalIssue("listing-promotional-metadata")
    ).not.toHaveProperty("portalCode");
    expect(openaiIssuePortalCode("no-such-id")).toBeUndefined();
  });
});

describe("a package finding", () => {
  it("carries the portal's code on each issue it groups", async () => {
    const files = {
      ...cleanSkillsPackage(),
      [CANONICAL_MANIFEST_PATH]: manifestJson({ name: "com.example.weather" }),
      "assets/icon.png": nonSquarePng(512, 256),
    };
    const evidence = await readOpenAIPluginPackage(
      new InMemoryOpenAIPackageSource(files),
      { archive: archiveObservations({ rawEntryNames: Object.keys(files) }) }
    );
    const findings = runOpenAIPackageChecks(
      { mode: "skills-only", package: evidence },
      { evaluatedAt: "2026-11-13T00:00:00.000Z" }
    );
    const issuesOf = (id: string) =>
      (findings.find((finding) => finding.id === id)?.details?.portalIssues ??
        []) as { id: string; portalCode?: string }[];
    expect(issuesOf("openai.package.manifest")).toEqual([
      expect.objectContaining({
        id: "plugin_name_format",
        portalCode: "plugin_name_format",
      }),
    ]);
    expect(issuesOf("openai.package.assets")).toEqual([
      expect.objectContaining({
        id: "asset-not-square",
        portalCode: "raster_image_not_square",
      }),
    ]);
  });
});

describe("checks that grade one portal code", () => {
  it("name codes from the MCP and review table", () => {
    for (const code of Object.values(OPENAI_CHECK_PORTAL_CODES)) {
      expect(OPENAI_PORTAL_CODES_BY_CODE[code].table).toBe(
        "MCP and review errors"
      );
    }
  });

  it("add `details.portalCode` to their findings and leave others alone", () => {
    const finding = (id: string): OpenAIReadinessFinding =>
      violated(
        {
          id,
          title: "A check",
          lane: "submission-artifacts",
          class: "required",
          source: openaiPolicySource("deploy/submission", "§Scan tools"),
          provenance: "static",
          intrusiveness: "passive",
        },
        { evaluatedAt: "2026-11-13T00:00:00.000Z" },
        "Run the scan.",
        { observed: 1 }
      );
    expect(
      withPortalCode(finding("openai.submission.scan-currency")).details
    ).toEqual({ observed: 1, portalCode: "scan_required" });
    const other = finding("openai.submission.attestations");
    expect(withPortalCode(other)).toBe(other);
  });

  it("are reported with the code by a graded run", () => {
    const result = gradeOpenAIReadiness({
      target: "https://plugin.example.com/mcp",
      mode: "mcp-only",
      authMode: "headless",
      capabilities: [],
      startedAt: "2026-11-13T12:00:00.000Z",
      evaluatedAt: "2026-11-13T12:00:05.000Z",
      durationMs: 5_000,
    });
    const codeOf = (id: string) =>
      result.findings.find((finding) => finding.id === id)?.details?.portalCode;
    expect(codeOf("openai.submission.scan-currency")).toBe("scan_required");
    expect(codeOf("openai.submission.annotation-justifications")).toBe(
      "justification_required"
    );
    expect(codeOf("openai.submission.attestations")).toBeUndefined();
  });
});
