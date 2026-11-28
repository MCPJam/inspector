import { openAIPackageSubmissionAnswers } from "../../src/openai-readiness/package/submission-answers.js";
import { describe, expect, it } from "vitest";
import { gradeOpenAIReadiness } from "../../src/openai-readiness/runner.js";
import { readOpenAIPluginPackage } from "../../src/openai-readiness/package/reader.js";
import {
  InMemoryOpenAIPackageSource,
  manifestJson,
} from "./package-fixtures.js";

const stamp = "2026-11-17T00:00:00Z";
async function grade(
  raw: Record<string, unknown>,
  hasPublishedVersion = false
) {
  const source = new InMemoryOpenAIPackageSource({
    ".codex-plugin/plugin.json": manifestJson(raw),
    ".mcp.json": JSON.stringify({
      mcpServers: { sample: { url: "https://example.com/mcp" } },
    }),
  });
  return gradeOpenAIReadiness({
    target: "https://example.com/mcp",
    mode: "mcp-uploaded-skills",
    authMode: "headless",
    capabilities: [],
    startedAt: stamp,
    evaluatedAt: stamp,
    durationMs: 0,
    submissionAnswers: [],
    hasPublishedVersion,
    package: await readOpenAIPluginPackage(source),
  });
}
const presentation = {
  displayName: "Sample",
  shortDescription: "Find sample notes",
  longDescription: "Search a sample workspace.",
  category: "Developer Tools",
  privacyPolicyURL: "https://example.com/privacy",
  supportURL: "https://example.com/help",
};

describe("package evidence in a saved ChatGPT rehearsal", () => {
  it("grades package listing and policy copy without importing credentials or inventing review materials", async () => {
    const result = await grade({
      interface: presentation,
      extensions: {
        "com.openai": {
          review: { test_credentials: { password: "DO_NOT_IMPORT" } },
        },
      },
    });
    for (const id of [
      "openai.submission.listing-fields",
      "openai.submission.urls",
      "openai.policy.non-promotional-listing",
    ]) {
      expect(result.findings.find((f) => f.id === id)).toMatchObject({
        status: "satisfied",
        details: { packageDerived: true },
      });
    }
    expect(
      result.findings.find((f) => f.id === "openai.submission.test-cases")
        ?.status
    ).toBe("violated");
    expect(
      result.findings.find((f) => f.id === "openai.submission.release-notes")
        ?.status
    ).toBe("not-applicable");
    expect(JSON.stringify(result.findings)).not.toContain("DO_NOT_IMPORT");
    expect(JSON.stringify(result.findings)).not.toMatch(
      /submissionProfile|no submission profile/
    );
  });
  it("grades an update's release notes and explicit country targeting", async () => {
    const result = await grade(
      {
        interface: presentation,
        extensions: {
          "com.openai": {
            publication: { release_notes: "Improved search", countries: [] },
          },
        },
      },
      true
    );
    for (const id of [
      "openai.submission.release-notes",
      "openai.submission.geography",
    ]) {
      expect(result.findings.find((f) => f.id === id)).toMatchObject({
        status: "satisfied",
        details: { packageDerived: true },
      });
    }
    const missing = await grade({ interface: presentation }, true);
    expect(
      missing.findings.find((f) => f.id === "openai.submission.release-notes")
        ?.status
    ).toBe("violated");
  });
  it("uses the OpenAI extension's listing over the legacy interface", async () => {
    const result = await grade({
      interface: presentation,
      extensions: {
        "com.openai": {
          interface: { ...presentation, supportURL: "http://example.com" },
        },
      },
    });
    expect(
      result.findings.find((f) => f.id === "openai.submission.urls")?.status
    ).toBe("violated");
  });
  it("does not confuse a publisher name with verified publishing permission", async () => {
    const result = await grade({ interface: presentation });
    expect(
      result.findings.find((f) => f.id === "openai.submission.account")
    ).toMatchObject({
      status: "not-evaluated",
      notEvaluatedReason: expect.stringContaining("OpenAI's dashboard"),
    });
  });
});

it("preserves saved review scalars on omission, but honors an explicit clear", async () => {
  const saved = [
    {
      key: "reviewer.releaseNotes",
      value: "Saved release notes",
      origin: "imported" as const,
    },
  ];
  const read = (publication: Record<string, unknown>) =>
    readOpenAIPluginPackage(
      new InMemoryOpenAIPackageSource({
        ".codex-plugin/plugin.json": manifestJson({
          extensions: { "com.openai": { publication } },
        }),
      })
    );
  expect(
    openAIPackageSubmissionAnswers(await read({}), saved).find(
      (a) => a.key === "reviewer.releaseNotes"
    )?.value
  ).toBe("Saved release notes");
  expect(
    openAIPackageSubmissionAnswers(
      await read({ release_notes: "" }),
      saved
    ).find((a) => a.key === "reviewer.releaseNotes")?.value
  ).toBe("");
});

it("preserves omitted test cases and clears both lists for an explicit empty declaration", async () => {
  const saved = [
    {
      key: "reviewer.testCases",
      value: [{ prompt: "Saved case" }],
      origin: "imported" as const,
    },
  ];
  const read = (review: Record<string, unknown>) =>
    readOpenAIPluginPackage(
      new InMemoryOpenAIPackageSource({
        ".codex-plugin/plugin.json": manifestJson({
          extensions: { "com.openai": { review } },
        }),
        ".mcp.json": JSON.stringify({
          mcpServers: { sample: { url: "https://example.com/mcp" } },
        }),
      })
    );
  expect(
    openAIPackageSubmissionAnswers(await read({}), saved).find(
      (a) => a.key === "reviewer.testCases"
    )?.value
  ).toEqual(saved[0].value);
  expect(
    openAIPackageSubmissionAnswers(await read({ test_cases: {} }), saved).find(
      (a) => a.key === "reviewer.testCases"
    )?.value
  ).toEqual([]);
});
