import { describe, expect, it } from "vitest";
import {
  inputAnswerResult,
  inputAnswersSchema,
  matchInputAnswer,
  MAX_INPUT_ANSWERS,
  type InputAnswer,
} from "../src/contract/input-answers.js";
import {
  loadEvalSuiteFile,
  serializeEvalSuiteFile,
} from "../src/suite-file-loader.js";
import {
  findFixture,
  suiteFileFixtures as data,
  suiteFilePayload as payload,
} from "./support/eval-suite-fixtures.js";

const answers: InputAnswer[] = [
  {
    server: "files",
    tool: "delete",
    message: "Delete",
    action: "accept",
    content: { sure: true },
  },
  { server: "files", action: "decline" },
  { message: "sign in", action: "accept" },
  { action: "cancel" },
];

describe("matchInputAnswer", () => {
  it("takes the first entry whose listed fields all fit, on server, tool and message", () => {
    const hit = (q: { server?: string; tool?: string; message: string }) =>
      matchInputAnswer(answers, q)?.index;
    expect(
      hit({ server: "files", tool: "delete", message: "Delete all of /tmp?" })
    ).toBe(0);
    // The tool is wrong, so the server-only entry answers.
    expect(
      hit({ server: "files", tool: "list", message: "Delete all of /tmp?" })
    ).toBe(1);
    // Another server, a message that fits the third entry.
    expect(hit({ server: "web", message: "Please sign in first" })).toBe(2);
    // Nothing else fits, so the default entry answers.
    expect(hit({ server: "web", message: "Anything" })).toBe(3);
  });

  it("does not let a question without a tool fit an entry that names one", () => {
    expect(
      matchInputAnswer([{ tool: "delete", action: "accept" }], {
        server: "files",
        message: "Delete?",
      })
    ).toBeUndefined();
  });

  it("matches the message exactly as written, case included", () => {
    expect(
      matchInputAnswer([{ message: "Delete", action: "accept" }], {
        message: "delete it",
      })
    ).toBeUndefined();
  });

  it("answers nothing for no replies, and declines", () => {
    expect(matchInputAnswer(undefined, { message: "x" })).toBeUndefined();
    expect(inputAnswerResult(undefined)).toEqual({ action: "decline" });
    expect(inputAnswerResult(answers[0])).toEqual({
      action: "accept",
      content: { sure: true },
    });
  });
});

describe("the replies schema", () => {
  it("accepts a list, and refuses content on a refusal, an unknown key and too many entries", () => {
    expect(inputAnswersSchema.safeParse(answers).success).toBe(true);
    expect(
      inputAnswersSchema.safeParse([{ action: "decline", content: { a: "b" } }])
        .success
    ).toBe(false);
    expect(
      inputAnswersSchema.safeParse([{ action: "accept", reply: 1 }]).success
    ).toBe(false);
    expect(inputAnswersSchema.safeParse([{ action: "maybe" }]).success).toBe(
      false
    );
    expect(
      inputAnswersSchema.safeParse(
        Array.from({ length: MAX_INPUT_ANSWERS + 1 }, () => ({
          action: "accept",
        }))
      ).success
    ).toBe(false);
  });
});

describe("a suite file with replies", () => {
  const base = payload(findFixture(data.accept, "dialect 2 — minimal")) as {
    cases: Array<Record<string, unknown>>;
  };
  const withAnswers = (inputAnswers: unknown) => ({
    ...base,
    cases: [{ ...base.cases[0], inputAnswers }, ...base.cases.slice(1)],
  });

  it("loads, resolves onto the case and writes back in place", () => {
    const text = JSON.stringify(withAnswers(answers));
    const loaded = loadEvalSuiteFile(text);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.resolved.cases[0]!.inputAnswers).toEqual(answers);
    expect(serializeEvalSuiteFile(loaded.authored)).toContain("inputAnswers");
  });

  it("refuses a bad reply with a finding that names where", () => {
    const loaded = loadEvalSuiteFile(
      JSON.stringify(withAnswers([{ action: "maybe" }]))
    );
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(JSON.stringify(loaded.findings)).toContain("inputAnswers");
  });
});
