/**
 * Answers to the ChatGPT flow, checked the way the portal and its reviewers
 * do: the reviewer credentials OpenAI asks for, a password that is a project
 * secret's name and never the password, and fields only a package import
 * may set.
 */

import { describe, expect, it } from "vitest";

import {
  CHATGPT_PLUGIN_FLOW as FLOW,
  directoryFlowField,
  placeDirectoryResults,
  validateDirectoryAnswerInput,
  validateDirectoryAnswers,
  type DirectoryAnswer,
  type DirectoryAnswerValue,
  type DirectoryReadinessFinding,
} from "../../src/directory-readiness/index.js";

const SECRET = "REVIEWER_PASSWORD";
/** What a person might paste where the secret's name goes. */
const PASSWORD = "sample-Passw0rd!";
const ATTESTATIONS = (
  directoryFlowField(FLOW, "submit.attestations")?.options ?? []
).map((option) => option.value);

const imported = (
  key: string,
  value: DirectoryAnswerValue
): DirectoryAnswer => ({
  key,
  value,
  origin: "imported",
});
const set = (key: string, value: DirectoryAnswerValue): DirectoryAnswer => ({
  key,
  value,
  origin: "set",
});
const cases = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    description: `Sample case ${index + 1}`,
    prompt: `Sample prompt ${index + 1}`,
  }));

/** A package's fields as an import stores them, and the reviewer's answers. */
function answers(changes: DirectoryAnswer[] = []): DirectoryAnswer[] {
  const complete: DirectoryAnswer[] = [
    imported("listing.displayName", "Sample Notes"),
    imported("listing.shortDescription", "Find and summarize notes"),
    imported("listing.description", "Search notes in a sample workspace."),
    imported("listing.developer", "Sample Publisher"),
    imported("listing.name", "sample-notes"),
    imported("listing.category", "Productivity"),
    imported("listing.website", "https://example.com/notes"),
    imported("listing.support", "https://example.com/support"),
    imported("listing.privacyPolicy", "https://example.com/privacy"),
    imported("listing.terms", "https://example.com/terms"),
    imported("mcp.serverUrl", "https://mcp.example.com/mcp"),
    imported("reviewer.testCases", cases(5)),
    imported("reviewer.negativeTestCases", cases(3)),
    imported("reviewer.demoRecordingUrl", "https://example.com/walkthrough"),
    imported("reviewer.releaseNotes", "Initial release."),
    set("reviewer.loginUrl", "https://app.example.com/login"),
    set("reviewer.username", "review@example.com"),
    set("reviewer.passwordSecret", SECRET),
    set("submit.developerIdentity", "Sample Publisher"),
    {
      key: "submit.attestations",
      value: ATTESTATIONS,
      origin: "confirmed",
      wordingRevision: FLOW.version,
    },
  ];
  const changed = new Set(changes.map((answer) => answer.key));
  return [...complete.filter((answer) => !changed.has(answer.key)), ...changes];
}

const issues = (
  given: DirectoryAnswer[],
  savedSecrets: readonly string[] | undefined = [SECRET]
) => validateDirectoryAnswers(FLOW, given, { savedSecrets });

describe("reviewer credentials", () => {
  it("leave a complete submission with no field issue", () => {
    expect(issues(answers())).toEqual([]);
  });

  it("ask for a login URL, a dedicated account's username and its password", () => {
    const empty = issues([], undefined).filter(
      (issue) => issue.step === "reviewer"
    );
    expect(
      empty
        .filter(
          (issue) =>
            issue.key.startsWith("reviewer.") && issue.code === "required"
        )
        .map((issue) => issue.key)
    ).toEqual(
      expect.arrayContaining([
        "reviewer.loginUrl",
        "reviewer.username",
        "reviewer.passwordSecret",
      ])
    );
    // Steps are asked for only once there is a tenant to choose.
    expect(empty.map((issue) => issue.key)).not.toContain(
      "reviewer.signInSteps"
    );
  });

  it("take an https login URL", () => {
    expect(
      issues(
        answers([set("reviewer.loginUrl", "http://app.example.com/login")])
      )
    ).toEqual([
      {
        key: "reviewer.loginUrl",
        step: "reviewer",
        code: "format",
        message: "Enter a full https:// URL.",
      },
    ]);
  });

  it("need sign-in steps once a tenant is named", () => {
    const tenant = set("reviewer.tenant", "Sample Org");
    expect(issues(answers([tenant]))).toEqual([
      {
        key: "reviewer.signInSteps",
        step: "reviewer",
        code: "required",
        message: "Add sign-in steps for the tenant you entered.",
      },
    ]);
    expect(
      issues(
        answers([
          tenant,
          set("reviewer.signInSteps", "Choose Sample Org after signing in."),
        ])
      )
    ).toEqual([]);
  });
});

describe("the reviewer's password", () => {
  it("is incomplete while the named secret holds no value, naming the secret and no value", () => {
    const found = issues(answers(), ["ANOTHER_SECRET"]);
    expect(found).toEqual([
      {
        key: "reviewer.passwordSecret",
        step: "reviewer",
        code: "secretUnset",
        message:
          "No value is saved for the project secret REVIEWER_PASSWORD. Save the password under that name.",
      },
    ]);
  });

  it("is not reported unset when nobody looked at the project's secrets", () => {
    expect(issues(answers(), undefined)).toEqual([]);
  });

  it("refuses a pasted password at the write, without repeating it", () => {
    for (const value of [PASSWORD, "reviewer_password", "1PASSWORD"]) {
      const refusal = validateDirectoryAnswerInput(
        FLOW,
        "reviewer.passwordSecret",
        value
      );
      expect(refusal, value).toMatchObject({
        key: "reviewer.passwordSecret",
        code: "format",
        message:
          "Password takes the name of a project secret, such as REVIEWER_PASSWORD, never the secret itself.",
      });
      expect(JSON.stringify(refusal)).not.toContain(value);
    }
    expect(
      validateDirectoryAnswerInput(FLOW, "reviewer.passwordSecret", SECRET)
    ).toBeUndefined();
  });

  it("shows the unset secret on the Review information step", () => {
    const steps = placeDirectoryResults({
      flow: FLOW,
      answers: answers(),
      savedSecrets: [],
    });
    const reviewer = steps.find((step) => step.step === "reviewer");
    expect(reviewer?.fieldIssues.map((issue) => issue.code)).toEqual([
      "secretUnset",
    ]);
    expect(reviewer?.counts.toFix).toBe(1);
  });
});

describe("fields the package manages", () => {
  it("refuse a person's write in the portal's words", () => {
    expect(
      validateDirectoryAnswerInput(FLOW, "listing.displayName", "Notes")
    ).toEqual({
      key: "listing.displayName",
      step: "listing",
      code: "managedByPackage",
      message:
        "Package details are read-only here; edit them in your source package.",
    });
    // Clearing one is not a write the portal refuses.
    expect(
      validateDirectoryAnswerInput(FLOW, "listing.displayName", null)
    ).toBeUndefined();
  });

  it("take what an import brings, refusing only a value of the wrong kind", () => {
    const prompts = ["One.", "Two.", "Three.", "Four."];
    expect(
      validateDirectoryAnswerInput(FLOW, "listing.starterPrompts", prompts, {
        origin: "imported",
      })
    ).toBeUndefined();
    expect(
      validateDirectoryAnswerInput(FLOW, "reviewer.testCases", cases(7), {
        origin: "imported",
      })
    ).toBeUndefined();
    expect(
      validateDirectoryAnswerInput(FLOW, "reviewer.testCases", "five", {
        origin: "imported",
      })
    ).toMatchObject({ code: "format" });
    // What the import stored, the review reports.
    expect(
      issues(answers([imported("listing.starterPrompts", prompts)]))
    ).toEqual([
      expect.objectContaining({
        key: "listing.starterPrompts",
        code: "tooMany",
      }),
    ]);
  });

  it("report the listing's limits and gaps with the portal's lines", () => {
    expect(
      issues(
        answers([imported("listing.displayName", "x".repeat(31))]).filter(
          (answer) => answer.key !== "listing.developer"
        )
      ).map(({ key, message }) => [key, message])
    ).toEqual([
      ["listing.displayName", "Display name must be 30 characters or fewer."],
      ["listing.developer", "Developer name is required."],
    ]);
  });

  it("count exactly five test cases and three negative ones", () => {
    expect(
      issues(
        answers([
          imported("reviewer.testCases", cases(4)),
          imported("reviewer.negativeTestCases", cases(4)),
        ])
      ).map(({ key, code, message }) => [key, code, message])
    ).toEqual([
      [
        "reviewer.testCases",
        "tooFew",
        "Supply at least 5 test cases. There are 4.",
      ],
      [
        "reviewer.negativeTestCases",
        "tooMany",
        "Supply at most 3 negative test cases. There are 4.",
      ],
    ]);
  });
});

describe("submitting", () => {
  it("asks for every attestation", () => {
    expect(
      issues(
        answers([
          {
            key: "submit.attestations",
            value: ATTESTATIONS.slice(1),
            origin: "confirmed",
            wordingRevision: FLOW.version,
          },
        ])
      )
    ).toEqual([
      {
        key: "submit.attestations",
        step: "submit",
        code: "tooFew",
        message: "Tick all 6 policy attestations to submit.",
      },
    ]);
  });

  it("places a finding named at run time on the upload step", () => {
    const finding: DirectoryReadinessFinding = {
      id: "openai.package.observation.rawEntryNames",
      title: "Archive observation: rawEntryNames",
      lane: "plugin-package",
      class: "required",
      status: "not-evaluated",
      notEvaluatedReason: "the source reported no entry names",
      source: {},
      provenance: "static",
      intrusiveness: "passive",
      evaluatedAt: "2026-11-13T00:00:00.000Z",
      engineVersion: "2",
    };
    const upload = placeDirectoryResults({
      flow: FLOW,
      answers: answers(),
      findings: [finding],
    }).find((step) => step.step === "upload");
    expect(upload?.findings).toEqual([
      expect.objectContaining({ finding, evidenceStatus: "blocked" }),
    ]);
  });
});
