/**
 * The redactor that stands between Convex's failure text and our own tooling.
 *
 * Tested DIRECTLY rather than through the logger, because asserting on a
 * logged `Error` via `JSON.stringify` proves nothing: `message` and `stack`
 * are non-enumerable, so a stringified Error is `{}` and a leak would pass.
 * Sentry reads `.message` off the object, so the object is what has to be
 * right.
 */
import { describe, it, expect } from "vitest";
import {
  redactForLog,
  redactedErrorForCapture,
} from "../redact-log-message.js";

describe("redactForLog — credential shapes", () => {
  it("redacts a standalone bearer token", () => {
    const out = redactForLog(new Error("sent Bearer abc.def-123 upstream"));
    expect(out).not.toContain("abc.def-123");
    expect(out).toContain("Bearer [redacted]");
  });

  it("redacts a bearer token behind an Authorization header name, exactly once", () => {
    // The header-name rule and the standalone-Bearer rule both match this
    // string. If both fire the result is a double-redacted
    // `authorization=[redacted] [redacted]` — safe, but noise; the key rule
    // swallows the `Bearer ` prefix so only one fires.
    const out = redactForLog(
      new Error("sent Authorization: Bearer abc.def-123")
    );
    expect(out).not.toContain("abc.def-123");
    // The key keeps the casing it arrived with — `$1` is the matched name.
    expect(out).toBe("sent Authorization=[redacted]");
  });

  it.each(["sk", "slk", "dsc", "api"])(
    "redacts a bare %s_ credential",
    (prefix) => {
      const out = redactForLog(
        new Error(`rejected ${prefix}_live_SECRETVALUE`)
      );
      expect(out).not.toContain("SECRETVALUE");
      expect(out).toContain(`${prefix}_[redacted]`);
    }
  );

  it("redacts anything JWT-shaped", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    expect(redactForLog(new Error(`token ${jwt} expired`))).not.toContain(jwt);
  });

  it.each([
    ["api_key=hunter2", "hunter2"],
    ["api-key: hunter2", "hunter2"],
    ["apikey=hunter2", "hunter2"],
    ['token="hunter2"', "hunter2"],
    ["secret: hunter2", "hunter2"],
    ["password=hunter2", "hunter2"],
    ["authorization=hunter2", "hunter2"],
  ])("redacts the VALUE in %s", (input, secret) => {
    // The regression this exists for: the bare-prefix rule matches the NAME
    // `api_key` and would rewrite `api_key=hunter2` to `api_[redacted]=hunter2`
    // — redacting the label and publishing the secret. The key=value rule has
    // to run first.
    const out = redactForLog(new Error(`Convex rejected: ${input}`));
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });

  it("stops the value at a delimiter rather than eating the rest of the line", () => {
    const out = redactForLog(
      new Error("api_key=hunter2&projectId=proj_123 was rejected")
    );
    expect(out).not.toContain("hunter2");
    // The non-secret context after the delimiter is what makes the log useful.
    expect(out).toContain("projectId=proj_123");
  });

  it("leaves an ordinary message untouched", () => {
    const message = "Journey not found for project proj_abc";
    expect(redactForLog(new Error(message))).toBe(message);
  });
});

describe("redactForLog — hostile and empty inputs", () => {
  it("never throws on a value whose toString throws", () => {
    // This function only ever runs while something ELSE has already failed. A
    // throw here escapes into the catch block that was reporting that failure,
    // losing the diagnostic and replacing the route's answer with a secondary
    // failure from the logging code.
    const hostile = {
      toString() {
        throw new Error("nope");
      },
    };
    expect(redactForLog(hostile)).toBe("[unreadable error value]");
  });

  it("never throws on an Error whose message getter throws", () => {
    const hostile = new Error("x");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("nope");
      },
    });
    expect(redactForLog(hostile)).toBe("[unreadable error value]");
  });

  it("survives a non-string message", () => {
    const weird = new Error("x");
    Object.defineProperty(weird, "message", { value: { a: 1 } });
    expect(typeof redactForLog(weird)).toBe("string");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
  ])("returns a string for %s", (_label, input) => {
    expect(typeof redactForLog(input)).toBe("string");
  });

  it("truncates a validator dump and says so", () => {
    const out = redactForLog(new Error("x".repeat(5000)));
    expect(out.length).toBeLessThan(500);
    expect(out).toContain("[truncated]");
  });
});

describe("redactedErrorForCapture", () => {
  it("carries the redacted message, not the original", () => {
    const error = redactedErrorForCapture(
      new Error("rejected sk_live_SECRETVALUE")
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("SECRETVALUE");
    expect(error.message).toContain("sk_[redacted]");
  });

  it("does not put the unredacted message back as the stack's first line", () => {
    // A JS stack string BEGINS with `Error: <message>`. Transplanting the
    // original stack onto a redacted error would restore the secret one field
    // over — the same leak, and the one Sentry actually displays.
    const original = new Error("rejected sk_live_SECRETVALUE");
    original.stack = [
      "Error: rejected sk_live_SECRETVALUE",
      "    at doThing (/app/thing.js:1:1)",
      "    at other (/app/other.js:2:2)",
    ].join("\n");

    const redacted = redactedErrorForCapture(original);

    expect(redacted.stack).not.toContain("SECRETVALUE");
    expect(redacted.stack?.split("\n")[0]).toBe(`Error: ${redacted.message}`);
    // The frames are the reason to keep a stack at all.
    expect(redacted.stack).toContain("at doThing (/app/thing.js:1:1)");
    expect(redacted.stack).toContain("at other (/app/other.js:2:2)");
  });

  it("keeps its own stack when the original has no frames", () => {
    const original = new Error("boom");
    original.stack = "Error: boom";
    const redacted = redactedErrorForCapture(original);
    expect(redacted.message).toBe("boom");
    expect(redacted).toBeInstanceOf(Error);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a plain string", "just a string"],
  ])("returns an Error for %s", (_label, input) => {
    expect(redactedErrorForCapture(input)).toBeInstanceOf(Error);
  });

  it("truncates a long message on the captured object too", () => {
    const error = redactedErrorForCapture(new Error("y".repeat(5000)));
    expect(error.message.length).toBeLessThan(500);
    expect(error.message).toContain("[truncated]");
  });
});
