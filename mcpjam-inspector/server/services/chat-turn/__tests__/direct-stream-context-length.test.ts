import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTEXT_LENGTH_EXCEEDED_MESSAGE } from "@mcpjam/sdk";
import { formatStreamError } from "../direct-stream.js";

type Row = {
  label: string;
  statusCode: number | null;
  message: string;
  responseBody: string | null;
};

// Read from disk: the corpus lives in the SDK package and is shared with the
// backend (pinned in its convex/lib/mirrors.json).
const fixtures = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../../sdk/tests/fixtures/context-length-parity-fixtures.json",
    ),
    "utf8",
  ),
) as { match: Row[]; noMatch: Row[] };

/** What the AI SDK throws for a row: `APICallError`'s fields on an Error. */
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

describe("formatStreamError: a chat too long for the model", () => {
  it.each(fixtures.match.map((row) => [row.label, row] as const))(
    "answers %s with the backend's code and sentence",
    (_label, row) => {
      const body = JSON.parse(formatStreamError(errorFor(row), "anthropic"));

      expect(body).toMatchObject({
        code: "context_length_exceeded",
        message: CONTEXT_LENGTH_EXCEEDED_MESSAGE,
        isRetryable: false,
        details: row.responseBody ?? row.message,
        normalized: { slug: "provider/context_length_exceeded" },
      });
    },
  );

  it.each(fixtures.noMatch.map((row) => [row.label, row] as const))(
    "leaves %s to the other rules",
    (_label, row) => {
      const body = JSON.parse(formatStreamError(errorFor(row), "anthropic"));

      expect(body.code).not.toBe("context_length_exceeded");
    },
  );
});
