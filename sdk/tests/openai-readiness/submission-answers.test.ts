import { describe, expect, it } from "vitest";
import {
  gradeOpenAIReadiness,
  type OpenAIReadinessEvidence,
} from "../../src/openai-readiness/runner.js";
import type { DirectoryAnswer } from "../../src/directory-readiness/flows/types.js";
import { CHATGPT_PLUGIN_FLOW } from "../../src/directory-readiness/flows/chatgpt-plugin.js";
import {
  directoryFlowField,
  directoryFieldWordingRevision,
} from "../../src/directory-readiness/flows/fields.js";

const base: OpenAIReadinessEvidence = {
  target: "https://example.com/mcp",
  mode: "mcp-only",
  authMode: "headless",
  capabilities: [],
  startedAt: "2026-11-16T00:00:00Z",
  evaluatedAt: "2026-11-16T00:00:00Z",
  durationMs: 0,
};
const answer = (
  key: string,
  value: DirectoryAnswer["value"],
  origin: DirectoryAnswer["origin"] = "set",
): DirectoryAnswer => ({ key, value, origin });
const finding = (answers: DirectoryAnswer[], id: string) =>
  gradeOpenAIReadiness({ ...base, submissionAnswers: answers }).findings.find(
    (item) => item.id === id,
  )!;

describe("ChatGPT saved answers", () => {
  it("requires every attestation and a current confirmation", () => {
    const key = "submit.attestations";
    const options = directoryFlowField(CHATGPT_PLUGIN_FLOW, key)?.options ?? [];
    const values = options.map((option) => option.value);
    expect(
      finding([answer(key, values.slice(1))], "openai.submission.attestations")
        .status,
    ).toBe("violated");
    const confirmed: DirectoryAnswer = {
      key,
      value: values,
      origin: "confirmed",
      wordingRevision: directoryFieldWordingRevision(CHATGPT_PLUGIN_FLOW, key),
    };
    expect(finding([confirmed], "openai.submission.attestations").status).toBe(
      "satisfied",
    );
    expect(
      finding(
        [{ ...confirmed, wordingRevision: "old" }],
        "openai.submission.attestations",
      ).status,
    ).toBe("violated");
  });
  it("grades provided credentials without treating an unimported recording as missing", () => {
    const answers = [
      answer("reviewer.loginUrl", "https://example.com/login"),
      answer("reviewer.username", "reviewer"),
      answer("reviewer.passwordSecret", "REVIEW_PASSWORD"),
    ];
    const result = finding(answers, "openai.submission.demo-access");
    expect(result.status).toBe("not-evaluated");
    expect(JSON.stringify(result)).not.toContain("REVIEW_PASSWORD");
    expect(
      finding(
        [
          ...answers,
          answer(
            "reviewer.demoRecordingUrl",
            "https://example.com/demo",
            "imported",
          ),
        ],
        "openai.submission.demo-access",
      ).status,
    ).toBe("satisfied");
    expect(
      finding(
        answers.filter((item) => item.key !== "reviewer.username"),
        "openai.submission.demo-access",
      ).status,
    ).toBe("violated");
  });
  it("grades imported package fields and does not invent absent ones", () => {
    expect(finding([], "openai.submission.test-cases").status).toBe(
      "not-evaluated",
    );
    expect(
      finding(
        [answer("reviewer.testCases", [], "imported")],
        "openai.submission.test-cases",
      ).status,
    ).toBe("violated");
    expect(
      finding(
        [answer("listing.privacyPolicy", "http://example.com", "imported")],
        "openai.submission.urls",
      ).status,
    ).toBe("violated");
  });
  it("uses the saved domain token and keeps legacy profile-less calls unchanged", () => {
    expect(
      finding(
        [answer("mcp.verificationToken", "token")],
        "openai.submission.domain-token",
      ).status,
    ).toBe("satisfied");
    expect(finding([], "openai.submission.domain-token").status).toBe(
      "violated",
    );
    expect(
      gradeOpenAIReadiness(base).findings.find(
        (item) => item.id === "openai.submission.domain-token",
      )?.status,
    ).toBe("not-evaluated");
  });
});
