/**
 * Answers checked as the Claude portal checks them, with its own words.
 *
 * The counts below are the portal's: an untouched draft shows 8 on the
 * Listing step and "9 fields to fix" on the review page, because the author
 * is asked for only at review.
 */

import { describe, expect, it } from "vitest";

import {
  CLAUDE_CONNECTOR_FLOW as FLOW,
  validateDirectoryAnswerInput,
  validateDirectoryAnswers,
  type DirectoryAnswer,
  type DirectoryFieldIssue,
} from "../../src/directory-readiness/index.js";
import {
  ACCOUNT_PREFILLS,
  ACKNOWLEDGMENT_VALUES,
  answer,
  completeAnswers,
} from "../support/claude-connector-answers.js";

const REQUIRED = "This field is required";
const AUTHOR =
  "An author is required to submit — add one on the Listing step, or fill in your company name and an https:// website to use those";
const ACKNOWLEDGE_ALL = "All policy items must be acknowledged";
const set = answer;
const ACCOUNT = ACCOUNT_PREFILLS;
const ACKNOWLEDGMENTS = ACKNOWLEDGMENT_VALUES;
const with_ = completeAnswers;

function issueFor(
  issues: DirectoryFieldIssue[],
  key: string
): DirectoryFieldIssue | undefined {
  return issues.find((issue) => issue.key === key);
}

function countByStep(issues: DirectoryFieldIssue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { step } of issues) counts[step] = (counts[step] ?? 0) + 1;
  return counts;
}

describe("an untouched draft", () => {
  it("counts what the portal's step markers count", () => {
    expect(countByStep(validateDirectoryAnswers(FLOW, ACCOUNT))).toEqual({
      connection: 1,
      listing: 8,
      useCases: 2,
      company: 1,
      dataHandling: 1,
      compliance: 1,
    });
  });

  it("adds the author on the review page, as the portal does", () => {
    const review = validateDirectoryAnswers(FLOW, ACCOUNT, { on: "review" });
    expect(countByStep(review).listing).toBe(9);
    expect(issueFor(review, "listing.authorName")).toEqual({
      key: "listing.authorName",
      step: "listing",
      code: "required",
      message: AUTHOR,
    });
  });

  it("uses the portal's own error line for each missing answer", () => {
    const issues = validateDirectoryAnswers(FLOW, ACCOUNT, { on: "review" });
    const lines = Object.fromEntries(
      issues.map((issue) => [issue.key, issue.message])
    );
    expect(lines).toMatchObject({
      "connection.serverUrl": REQUIRED,
      "listing.name": REQUIRED,
      "listing.slug": "Slug is required",
      "listing.oneLiner": REQUIRED,
      "listing.categories": "Select at least one category",
      "listing.support": REQUIRED,
      "useCases.pairs": "Add at least one use case with an example prompt",
      "useCases.prerequisites": REQUIRED,
      "company.website": REQUIRED,
      "dataHandling.sponsored": REQUIRED,
      "compliance.acknowledgments": ACKNOWLEDGE_ALL,
    });
    expect(issues.every((issue) => issue.code === "required")).toBe(true);
  });

  it("holds the portal's defaults, which count as answered", () => {
    const keys = validateDirectoryAnswers(FLOW, []).map((issue) => issue.key);
    expect(keys).not.toContain("useCases.access");
    expect(keys).not.toContain("authentication.requirement");
    expect(keys).not.toContain("dataHandling.healthData");
  });
});

describe("a complete submission", () => {
  it("raises nothing on the form or the review page", () => {
    expect(validateDirectoryAnswers(FLOW, completeAnswers())).toEqual([]);
    expect(
      validateDirectoryAnswers(FLOW, completeAnswers(), { on: "review" })
    ).toEqual([]);
  });
});

describe("the author, asked for only at review", () => {
  const review = (answers: DirectoryAnswer[]) =>
    issueFor(
      validateDirectoryAnswers(FLOW, answers, { on: "review" }),
      "listing.authorName"
    );

  it("falls back to the company name and an https website", () => {
    expect(review(completeAnswers())).toBeUndefined();
  });

  it("refuses the fallback when the website is not https", () => {
    expect(
      review(with_([set("company.website", "http://acme.example")]))?.message
    ).toBe(AUTHOR);
  });

  it("refuses the fallback without a company name", () => {
    expect(review(with_([set("company.name", " ")]))?.code).toBe("required");
  });

  it("is satisfied by an author name alone", () => {
    expect(
      review(
        with_([
          set("company.website", "http://acme.example"),
          set("listing.authorName", "Acme Labs"),
        ])
      )
    ).toBeUndefined();
  });

  it("is never asked for on the form", () => {
    const answers = with_([set("company.website", "http://acme.example")]);
    expect(
      issueFor(validateDirectoryAnswers(FLOW, answers), "listing.authorName")
    ).toBeUndefined();
  });
});

describe("each issue code", () => {
  const only = (answers: DirectoryAnswer[], key: string) =>
    issueFor(validateDirectoryAnswers(FLOW, answers), key);

  it("tooLong: a one-liner over the portal's counter", () => {
    expect(
      only(
        with_([set("listing.oneLiner", "x".repeat(200))]),
        "listing.oneLiner"
      )
    ).toBeUndefined();
    expect(
      only(
        with_([set("listing.oneLiner", "x".repeat(201))]),
        "listing.oneLiner"
      )
    ).toEqual({
      key: "listing.oneLiner",
      step: "listing",
      code: "tooLong",
      message: "Use 200 characters or fewer. This has 201.",
    });
  });

  it("format: links, contacts and the slug", () => {
    const format = (key: string, value: string) =>
      only(with_([set(key, value)]), key);
    expect(format("listing.slug", "Acme Orders")).toMatchObject({
      code: "format",
      message: "Use only lowercase letters, numbers, and hyphens.",
    });
    expect(
      format("listing.documentationUrl", "http://acme.example/docs")
    ).toMatchObject({
      code: "format",
      message: "Enter a full https:// URL.",
    });
    expect(
      format("listing.support", "https://acme.example/help")
    ).toBeUndefined();
    expect(format("listing.support", "the help desk")).toMatchObject({
      code: "format",
      message: "Enter a URL or an email address.",
    });
    expect(format("company.contactEmail", "review.example.com")).toMatchObject({
      code: "format",
      message: "Enter an email address.",
    });
  });

  it("format: a value of the wrong kind for its control", () => {
    expect(validateDirectoryAnswerInput(FLOW, "listing.oneLiner", 42)).toEqual({
      key: "listing.oneLiner",
      step: "listing",
      code: "format",
      message: "One-liner takes text.",
    });
    expect(
      validateDirectoryAnswerInput(FLOW, "testLaunch.selfTested", "yes")
        ?.message
    ).toBe(
      "I have run every tool via MCP Inspector or as a custom connector in Claude takes true or false."
    );
    expect(
      validateDirectoryAnswerInput(FLOW, "useCases.pairs", [
        { useCase: "Track", prompt: "Where is it?" },
      ])?.code
    ).toBe("format");
  });

  it("tooMany: more than the portal's control holds, refused at write", () => {
    const six = ["a", "b", "c", "d", "e", "f"];
    expect(
      validateDirectoryAnswerInput(FLOW, "listing.categories", six)
    ).toMatchObject({ code: "tooMany", message: "Choose up to 5." });
    const row = { useCase: "Track", examplePrompt: "Where is it?" };
    expect(
      validateDirectoryAnswerInput(FLOW, "useCases.pairs", [row, row, row, row])
    ).toMatchObject({ code: "tooMany", message: "Choose up to 3." });
  });

  it("tooFew: six of the seven acknowledgments", () => {
    expect(
      only(
        with_([set("compliance.acknowledgments", ACKNOWLEDGMENTS.slice(1))]),
        "compliance.acknowledgments"
      )
    ).toEqual({
      key: "compliance.acknowledgments",
      step: "compliance",
      code: "tooFew",
      message: ACKNOWLEDGE_ALL,
    });
  });

  it("tooFew: one acknowledgment ticked seven times is still one", () => {
    const repeated = Array.from({ length: 7 }, () => ACKNOWLEDGMENTS[0]);
    expect(
      only(
        with_([set("compliance.acknowledgments", repeated)]),
        "compliance.acknowledgments"
      )?.code
    ).toBe("tooFew");
  });

  it("unknownOption: a choice the portal does not offer", () => {
    expect(
      validateDirectoryAnswerInput(FLOW, "useCases.access", "admin")
    ).toMatchObject({
      code: "unknownOption",
      message: "Choose one of: read-only, write-only, read-write.",
    });
    expect(
      validateDirectoryAnswerInput(FLOW, "compliance.acknowledgments", [
        "developer-guidelines",
        "made-up",
      ])?.code
    ).toBe("unknownOption");
  });

  it("unknownField: a key the flow does not have", () => {
    expect(validateDirectoryAnswerInput(FLOW, "listing.tagline", "x")).toEqual({
      key: "listing.tagline",
      step: "listing",
      code: "unknownField",
      message:
        "This flow has no field listing.tagline. Read the flow for its field keys.",
    });
    expect(
      issueFor(
        validateDirectoryAnswers(FLOW, with_([set("listing.tagline", "x")])),
        "listing.tagline"
      )?.code
    ).toBe("unknownField");
  });

  it("required: a use case without its example prompt is no use case", () => {
    expect(
      only(
        with_([
          set("useCases.pairs", [{ useCase: "Track", examplePrompt: " " }]),
        ]),
        "useCases.pairs"
      )?.message
    ).toBe("Add at least one use case with an example prompt");
  });
});

describe("a confirmation made under other wording", () => {
  const confirmed = (wordingRevision: string | undefined): DirectoryAnswer => ({
    key: "dataHandling.healthData",
    value: "no",
    origin: "confirmed",
    ...(wordingRevision === undefined ? {} : { wordingRevision }),
  });
  const issue = (answer: DirectoryAnswer) =>
    issueFor(
      validateDirectoryAnswers(FLOW, with_([answer])),
      "dataHandling.healthData"
    );

  it("has to be confirmed again", () => {
    expect(issue(confirmed("2026-01-01"))).toEqual({
      key: "dataHandling.healthData",
      step: "dataHandling",
      code: "wordingChanged",
      message:
        "The wording changed after this was confirmed. Read it again and confirm it.",
    });
    expect(issue(confirmed(undefined))?.code).toBe("wordingChanged");
  });

  it("stands under the current wording", () => {
    expect(issue(confirmed(FLOW.version))).toBeUndefined();
  });

  it("applies to confirmations of declarations only", () => {
    expect(
      issue({ ...confirmed("2026-01-01"), origin: "set" })
    ).toBeUndefined();
    const name: DirectoryAnswer = {
      key: "listing.name",
      value: "Acme Orders",
      origin: "confirmed",
      wordingRevision: "2026-01-01",
    };
    expect(
      issueFor(validateDirectoryAnswers(FLOW, with_([name])), "listing.name")
    ).toBeUndefined();
  });
});

describe("the write gate", () => {
  it("stores what the portal lets a person type and complains about later", () => {
    for (const [key, value] of [
      ["listing.oneLiner", "x".repeat(201)],
      ["listing.documentationUrl", "http://acme.example/docs"],
      ["listing.slug", "Acme Orders"],
      ["useCases.access", ""],
      ["listing.categories", null],
    ] as const) {
      expect(
        validateDirectoryAnswerInput(FLOW, key, value),
        key
      ).toBeUndefined();
    }
  });
});
