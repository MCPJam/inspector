/**
 * The three traps that kept a ChatGPT rehearsal from reaching `ready`:
 *
 *   - the domain challenge failed on a 404 before the portal had issued a
 *     token, so every server that had not been through the portal was
 *     not ready;
 *   - three UI checks waited on evidence nothing gathers;
 *   - the ZIP adapter never reported encryption flags, so a valid package's
 *     lane stayed incomplete.
 */

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { runOpenAIDomainVerificationChecks } from "../../src/openai-readiness/checks/domain-verification.js";
import { xmldomParseXml } from "../../src/openai-readiness/package/svg-xml-node.js";
import {
  gatherOpenAIReadinessEvidence,
  gradeOpenAIReadiness,
  type OpenAIReadinessEvidence,
} from "../../src/openai-readiness/runner.js";
import type { OpenAIReadinessResult } from "../../src/openai-readiness/types.js";
import { directoryVerdict } from "../../src/directory-readiness/index.js";
import {
  collectZipArchiveObservations,
  createZipPluginFileSource,
} from "../../src/plugin-bundle/node-file-sources.js";
import {
  SAMPLE_SERVER_URL,
  samplePackageFiles,
  wrappedSamplePackageFiles,
} from "../plugin-bundle/chatgpt-package-fixtures.js";
import { healthyServerEvidence } from "./server-fixtures.js";
import { completeSubmissionProfile } from "./submission-fixtures.js";

const STAMP = { evaluatedAt: "2026-11-13T00:00:00.000Z" };
const CHALLENGE =
  "https://plugin.example.com/.well-known/openai-apps-challenge";
const SERVED = "openai.domain.challenge-served";
const UNGATHERED = [
  "openai.ui.csp-exact",
  "openai.ui.output-schema",
  "openai.ui.useful-without-ui",
];
/** The decision checks, listed apart the same way while the scan is off. */
const DECISIONS = [
  "both.decision.annotation-matches-behaviour",
  "openai.decision.fair-play",
  "openai.decision.secret-seeking",
];

function run(overrides: Partial<OpenAIReadinessEvidence> = {}) {
  return gradeOpenAIReadiness({
    target: "https://plugin.example.com/mcp",
    mode: "mcp-only",
    authMode: "headless",
    capabilities: [],
    startedAt: "2026-11-13T00:00:00.000Z",
    evaluatedAt: "2026-11-13T00:00:05.000Z",
    durationMs: 5_000,
    ...healthyServerEvidence(),
    submissionProfile: completeSubmissionProfile(),
    ...overrides,
  });
}

function byId(result: OpenAIReadinessResult, id: string) {
  const found = result.findings.find((finding) => finding.id === id);
  if (!found) throw new Error(`the run reported no ${id}`);
  return found;
}

function lane(result: OpenAIReadinessResult, name: string) {
  const found = result.lanes.find((entry) => entry.lane === name);
  if (!found) throw new Error(`the run reported no ${name} lane`);
  return found;
}

describe("the domain challenge before the portal has issued a token", () => {
  const notFound = { url: CHALLENGE, status: 404, body: "" };

  it("is not evaluated on a 404, with the reason and the next step", () => {
    const [served] = runOpenAIDomainVerificationChecks(
      { evidence: notFound },
      STAMP
    );
    expect(served).toMatchObject({ id: SERVED, status: "not-evaluated" });
    expect(served.notEvaluatedReason).toContain("has no verification token");
    expect(served.remediation).toBe(
      "When the portal shows your verification token, serve exactly that token as plain text at /.well-known/openai-apps-challenge on the server's origin, then add the token to this run."
    );
    // The gap names the input that closes it.
    expect(served.details).toMatchObject({
      missingInput: "submissionProfile",
      field: "domainVerificationToken",
    });
  });

  it("fails a 404 once the run has a token to compare", () => {
    const [served] = runOpenAIDomainVerificationChecks(
      { evidence: notFound, declaredToken: "sample-token" },
      STAMP
    );
    expect(served.status).toBe("violated");
  });

  it("still fails an answer that is not a 404 without a token", () => {
    const [served] = runOpenAIDomainVerificationChecks(
      { evidence: { ...notFound, status: 403 } },
      STAMP
    );
    expect(served.status).toBe("violated");
  });

  it("leaves the technical preflight incomplete rather than not ready", () => {
    const result = run({
      domainVerification: notFound,
      submissionProfile: undefined,
    });
    expect(byId(result, SERVED).status).toBe("not-evaluated");
    expect(lane(result, "directory-policy").status).toBe("incomplete");
    expect(
      result.stages.find((stage) => stage.stage === "technical-preflight")
        ?.status
    ).toBe("incomplete");
  });
});

describe("the UI checks no run gathers evidence for", () => {
  // A served template with its domain and CSP declared: everything the dial
  // reads. Nothing renders it, so nothing observes what it loads or shows.
  const withTemplate = {
    appsUi: {
      resources: [
        {
          uri: "ui://notes/card",
          mimeType: "text/html;profile=mcp-app",
          domain: "card.notes.example.com",
          declaredCspDomains: ["cdn.notes.example.com"],
          referencedByTools: ["get_forecast"],
        },
      ],
    },
  };

  it("reports each not evaluated, saying no run gathers what it grades", () => {
    const result = run(withTemplate);
    for (const id of UNGATHERED) {
      const finding = byId(result, id);
      expect(finding.status, id).toBe("not-evaluated");
      expect(finding.notEvaluatedReason, id).toMatch(
        /^no run (renders|judges)/
      );
      expect(finding.details?.ungatheredEvidence, id).toBeTruthy();
    }
  });

  it("never blocks ready: the verdict lists them apart, with their reasons", () => {
    const result = run(withTemplate);
    for (const path of ["hosted", "cli"] as const) {
      const verdict = directoryVerdict(result.findings, { path });
      expect(verdict, path).toMatchObject({
        verdict: "ready",
        failing: [],
        undetermined: [],
      });
      expect(verdict.notCheckedOnPath, path).toEqual(
        [...UNGATHERED, ...DECISIONS].sort()
      );
      for (const id of UNGATHERED) {
        expect(verdict.notCheckedReasons[id]).toBe(
          byId(result, id).notEvaluatedReason
        );
      }
    }
  });

  it("gates one again when failOn names it", () => {
    const verdict = directoryVerdict(run(withTemplate).findings, {
      path: "hosted",
      checkGate: { failOn: ["openai.ui.csp-exact"] },
    });
    expect(verdict).toMatchObject({
      verdict: "incomplete",
      undetermined: ["openai.ui.csp-exact"],
    });
  });

  it("grades a template whose evidence a caller did supply", () => {
    const resource = {
      ...withTemplate.appsUi.resources[0],
      observedDomains: ["cdn.notes.example.com", "tracker.example.net"],
    };
    const result = run({ appsUi: { resources: [resource] } });
    expect(byId(result, "openai.ui.csp-exact").status).toBe("violated");
    expect(directoryVerdict(result.findings, { path: "hosted" })).toMatchObject(
      { verdict: "not-ready", failing: ["openai.ui.csp-exact"] }
    );
  });
});

describe("a valid package read through the ZIP adapter", () => {
  async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
    const zip = new JSZip();
    for (const [path, content] of Object.entries(files))
      zip.file(path, content);
    return zip.generateAsync({ type: "uint8array" });
  }

  async function gradeZip(
    files: Record<string, string>,
    observe = collectZipArchiveObservations
  ) {
    const bytes = await zipOf(files);
    return gradeOpenAIReadiness(
      await gatherOpenAIReadinessEvidence({
        target: SAMPLE_SERVER_URL,
        mode: "mcp-uploaded-skills",
        packageSource: await createZipPluginFileSource(bytes),
        archive: await observe(bytes),
        parseXml: xmldomParseXml,
        now: () => new Date(STAMP.evaluatedAt),
      })
    );
  }

  for (const [layout, files] of [
    ["at the archive root", samplePackageFiles()],
    ["wrapped in one folder", wrappedSamplePackageFiles()],
  ] as const) {
    it(`grades the package lane ready, ${layout}`, async () => {
      const result = await gradeZip(files);
      expect(lane(result, "plugin-package")).toMatchObject({
        status: "ready",
        coverage: { notEvaluated: 0, missingInputs: [] },
      });
      expect(
        result.findings.filter((finding) =>
          finding.id.startsWith("openai.package.observation.")
        )
      ).toEqual([]);
    });
  }

  it("stays incomplete when the adapter cannot say which entries are encrypted", async () => {
    // What the adapter reported before it read the flags.
    const result = await gradeZip(samplePackageFiles(), async (bytes) => ({
      ...(await collectZipArchiveObservations(bytes)),
      encryptedEntryPaths: undefined,
    }));
    expect(lane(result, "plugin-package").status).toBe("incomplete");
    expect(
      byId(result, "openai.package.observation.encryptedEntryPaths").status
    ).toBe("not-evaluated");
  });
});
