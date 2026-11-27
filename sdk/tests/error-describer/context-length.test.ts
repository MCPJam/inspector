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
import {
  CONTEXT_LENGTH_EXCEEDED_MESSAGE,
  contextLengthCounts,
} from "../../src/error-describer/context-length.js";

type Row = {
  label: string;
  statusCode: number | null;
  message: string;
  responseBody: string | null;
  jsonRpcCode?: number;
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
  if (row.jsonRpcCode !== undefined) {
    Object.assign(error, { code: row.jsonRpcCode });
  }
  return error;
}

const SLUG = "provider/context_length_exceeded";

describe("contextLengthCounts", () => {
  it.each(fixtures.match.map((row) => [row.label, row] as const))(
    "reads the counts the provider stated: %s",
    (_label, row) => {
      // The banner gets the provider body as `details`; the counts come from
      // there, or from the message when there is no body.
      expect(contextLengthCounts(row.responseBody ?? row.message)).toEqual(
        row.counts
      );
    }
  );

  it("reads the current error, not previous_errors", () => {
    const body = JSON.stringify({
      error: {
        message:
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 300000 tokens.",
        metadata: {
          previous_errors: [
            { raw: "prompt is too long: 596303 tokens > 200000 maximum" },
          ],
        },
      },
    });
    expect(contextLengthCounts(body)).toEqual({ used: 300000, limit: 128000 });
  });
});

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

  it("ignores history in a plain record and keeps a numeric 500", () => {
    const history = fixtures.noMatch.find((row) =>
      row.label.startsWith("An unrelated 400 whose earlier attempt")
    )!;
    expect(
      describeError({
        message: history.message,
        statusCode: 400,
        responseBody: history.responseBody,
      }).slug
    ).not.toBe(SLUG);
    expect(
      describeError(
        Object.assign(
          new Error("prompt is too long: 596303 tokens > 200000 maximum"),
          { name: "SdkHttpError", code: 500 }
        )
      ).slug
    ).not.toBe(SLUG);
  });

  it("keeps a plain record's structured code", () => {
    expect(
      describeError({
        message: "Bad Request",
        code: "context_length_exceeded",
        statusCode: 400,
      }).slug
    ).toBe(SLUG);
  });

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
