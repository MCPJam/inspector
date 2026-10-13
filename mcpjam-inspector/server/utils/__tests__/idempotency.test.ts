import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import { WebRouteError } from "../../routes/web/errors.js";
import {
  readAnyIdempotencyKey,
  readIdempotencyKeyStrict,
} from "../idempotency.js";

/** Just enough of a Hono context for the header readers. */
function contextWith(headers: Record<string, string>): Context {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
  } as unknown as Context;
}

function refusalOf(headers: Record<string, string>): WebRouteError {
  try {
    readIdempotencyKeyStrict(contextWith(headers));
  } catch (error) {
    if (error instanceof WebRouteError) return error;
    throw error;
  }
  throw new Error("expected readIdempotencyKeyStrict to throw");
}

describe("readIdempotencyKeyStrict", () => {
  it("is undefined when neither header is sent", () => {
    expect(readIdempotencyKeyStrict(contextWith({}))).toBeUndefined();
  });

  it("reads either header, trimmed", () => {
    expect(
      readIdempotencyKeyStrict(contextWith({ "idempotency-key": " key-a " }))
    ).toBe("key-a");
    expect(
      readIdempotencyKeyStrict(
        contextWith({ "x-mcpjam-idempotency-key": "key-b" })
      )
    ).toBe("key-b");
  });

  it("accepts the same key on both headers", () => {
    expect(
      readIdempotencyKeyStrict(
        contextWith({
          "idempotency-key": "key-a",
          "x-mcpjam-idempotency-key": "key-a",
        })
      )
    ).toBe("key-a");
  });

  it("accepts a key of exactly 256 characters", () => {
    const key = "k".repeat(256);
    expect(
      readIdempotencyKeyStrict(contextWith({ "idempotency-key": key }))
    ).toBe(key);
  });

  it.each([
    ["an empty idempotency-key", { "idempotency-key": "" }, "idempotency-key"],
    [
      "a blank x-mcpjam-idempotency-key",
      { "x-mcpjam-idempotency-key": "   " },
      "x-mcpjam-idempotency-key",
    ],
    [
      "a 257-character key",
      { "idempotency-key": "k".repeat(257) },
      "idempotency-key",
    ],
  ])("refuses %s with a 400 naming the header", (_name, headers, header) => {
    const error = refusalOf(headers);
    expect(error.status).toBe(400);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain(header);
  });

  it("refuses two headers with different keys rather than picking one", () => {
    const error = refusalOf({
      "idempotency-key": "key-a",
      "x-mcpjam-idempotency-key": "key-b",
    });
    expect(error.status).toBe(400);
    expect(error.message).toContain("different keys");
  });

  it("leaves the lenient reader lenient", () => {
    // The existing routes' contract: an unusable key degrades to no key.
    expect(
      readAnyIdempotencyKey(contextWith({ "idempotency-key": "k".repeat(257) }))
    ).toBeUndefined();
    expect(
      readAnyIdempotencyKey(contextWith({ "idempotency-key": "  " }))
    ).toBeUndefined();
  });
});
