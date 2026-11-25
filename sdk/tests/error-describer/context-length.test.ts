/**
 * A provider refusing a request that does not fit the model's context window.
 *
 * The backend's stream classifiers recognize the same refusals in their own
 * module (`convex/lib/contextLengthError.ts`). Both repos read the SAME
 * fixture file, pinned by `context-length-parity-fixtures` in the backend's
 * `convex/lib/mirrors.json`, so a wording added on one side alone fails there.
 */
import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/context-length-parity-fixtures.json" with { type: "json" };
import {
  describeError,
  ERROR_CATALOG,
} from "../../src/error-describer/index.js";
import { CONTEXT_LENGTH_EXCEEDED_MESSAGE } from "../../src/error-describer/context-length.js";

type Row = {
  label: string;
  statusCode: number | null;
  message: string;
  responseBody: string | null;
};

/** The error the AI SDK raises for a row: `APICallError`'s shape, or a bare Error. */
function errorFor(row: Row): Error {
  const error = new Error(row.message);
  if (row.statusCode !== null) {
    Object.assign(error, { statusCode: row.statusCode });
  }
  if (row.responseBody !== null) {
    Object.assign(error, { responseBody: row.responseBody });
  }
  return error;
}

const SLUG = "provider/context_length_exceeded";

describe("describeError: a chat too long for the model", () => {
  it.each(fixtures.match.map((row) => [row.label, row] as const))(
    "recognizes %s",
    (_label, row) => {
      expect(describeError(errorFor(row)).slug).toBe(SLUG);
    }
  );

  it.each(fixtures.noMatch.map((row) => [row.label, row] as const))(
    "leaves alone %s",
    (_label, row) => {
      expect(describeError(errorFor(row)).slug).not.toBe(SLUG);
    }
  );

  it("recognizes the backend's own sentence, all an eval card keeps", () => {
    expect(describeError(CONTEXT_LENGTH_EXCEEDED_MESSAGE).slug).toBe(SLUG);
  });

  it("titles the card with the approved copy and never pages", () => {
    const described = describeError(CONTEXT_LENGTH_EXCEEDED_MESSAGE);
    expect(described).toMatchObject({
      title: "Chat too long for this model",
      oneLine: "This chat is longer than the model's context window.",
      nextSteps: [
        "Reset the chat and ask again.",
        "Have the tool return less, or a link instead of file contents.",
        "Choose a model with a larger context window.",
      ],
      severity: "warning",
      origin: "user_config",
    });
    expect(ERROR_CATALOG[SLUG].docsAnchor).toMatch(/#provider-errors$/);
  });
});
