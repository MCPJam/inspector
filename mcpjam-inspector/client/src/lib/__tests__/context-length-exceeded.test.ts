import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  contextLengthCounts,
  describeContextLengthExceeded,
  isContextLengthExceededCode,
} from "../context-length-exceeded";

type Row = {
  label: string;
  message: string;
  responseBody: string | null;
  counts: { used: number; limit: number } | null;
};

// Read from disk rather than imported: the corpus lives in the SDK package and
// is shared with the backend (pinned in its convex/lib/mirrors.json).
const fixtures = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../../sdk/tests/fixtures/context-length-parity-fixtures.json",
    ),
    "utf8",
  ),
) as { match: Row[] };

describe("contextLengthCounts", () => {
  it.each(fixtures.match.map((row) => [row.label, row] as const))(
    "reads the counts the provider stated: %s",
    (_label, row) => {
      // The banner gets the provider body as `details`; the counts come from
      // there, or from the message when there is no body.
      expect(contextLengthCounts(row.responseBody ?? row.message)).toEqual(
        row.counts,
      );
    },
  );
});

describe("contextLengthCounts ignores earlier attempts", () => {
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

describe("describeContextLengthExceeded", () => {
  it("states the counts when the provider gave them", () => {
    const described = describeContextLengthExceeded(
      '{"message":"prompt is too long: 596303 tokens > 200000 maximum"}',
    );

    expect(described.title).toBe("Chat too long for this model");
    expect(described.oneLine).toBe(
      "This chat has 596,303 tokens, and the model accepts up to 200,000.",
    );
  });

  it("keeps the catalog sentence when they did not", () => {
    expect(
      describeContextLengthExceeded("Input is too long for requested model.")
        .oneLine,
    ).toBe("This chat is longer than the model's context window.");
    expect(describeContextLengthExceeded(undefined).oneLine).toBe(
      "This chat is longer than the model's context window.",
    );
  });
});

describe("isContextLengthExceededCode", () => {
  it("is only the backend's code", () => {
    expect(isContextLengthExceededCode("context_length_exceeded")).toBe(true);
    expect(isContextLengthExceededCode("provider_error")).toBe(false);
    expect(isContextLengthExceededCode(undefined)).toBe(false);
  });
});
