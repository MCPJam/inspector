import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * How a Convex read failure becomes an HTTP answer, and what reaches the log.
 *
 * Three outcomes, and the two neighbours of each are wrong for it:
 *   membership   → 404 (a 403 would confirm the resource exists)
 *   credential   → 401 (404 says "forget it", 502 says "retry forever")
 *   anything else→ 502, with the upstream text in the LOG, never the response
 *
 * The redaction is the part worth a test of its own: it was written once as a
 * structured field only, while `logger.error` hands its second argument to
 * `Sentry.captureException` — which reads `.message` off it. The scrubbing was
 * decorative until the ERROR passed in was the redacted one.
 */

const { errorMock } = vi.hoisted(() => ({ errorMock: vi.fn() }));
vi.mock("../../../utils/logger.js", () => ({
  logger: { error: errorMock, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  classifyConvexReadError,
  translateConvexReadError,
} from "../convex-read-errors.js";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

const translate = (message: string) =>
  translateConvexReadError(new Error(message), { scope: "v1.test" });

describe("classifyConvexReadError", () => {
  it.each([
    "Not a member of this project",
    "Insufficient project permissions: requires admin",
  ])("reads %s as a membership refusal", (message) => {
    expect(classifyConvexReadError(new Error(message)).kind).toBe("membership");
  });

  it.each([
    "Unauthenticated",
    "invalid token",
    "token expired",
    "jwt malformed",
  ])("reads %s as an authentication failure", (message) => {
    expect(classifyConvexReadError(new Error(message)).kind).toBe(
      "authentication"
    );
  });

  it("does NOT read a bare 'not found' as membership", () => {
    // A renamed or undeployed Convex function says this. Calling it membership
    // would answer 404 — telling a caller their resource is gone during an
    // outage of ours.
    expect(
      classifyConvexReadError(new Error("journeys:nope not found")).kind
    ).toBe("upstream");
  });
});

describe("translateConvexReadError", () => {
  it("maps the three kinds to 404 / 401 / 502", () => {
    expect(translate("Not a member of this project").status).toBe(404);
    expect(translate("token expired").status).toBe(401);
    expect(translate("boom").status).toBe(502);
  });

  it("never puts upstream text in the 502 RESPONSE", () => {
    const err = translate("ArgumentValidationError: secret-arg-value");
    expect(err.message).toBe("Upstream request failed");
    expect(err.message).not.toContain("secret-arg-value");
  });

  it("redacts the ERROR it logs, not just the structured field", () => {
    // `logger.error` forwards arg 2 to `Sentry.captureException`, which reads
    // `.message`. Redacting only the third argument left the raw text going to
    // Sentry regardless.
    translate("failed with Authorization: Bearer abc.def.ghi and sk_live_1234");

    const [, loggedError, context] = errorMock.mock.calls[0]!;
    for (const seen of [
      (loggedError as Error).message,
      (context as { message: string }).message,
    ]) {
      expect(seen).toContain("Bearer [redacted]");
      expect(seen).toContain("sk_[redacted]");
      expect(seen).not.toContain("abc.def.ghi");
      expect(seen).not.toContain("sk_live_1234");
    }
  });

  it("redacts a JWT-shaped string", () => {
    translate("rejected eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.body.sig");
    expect((errorMock.mock.calls[0]![1] as Error).message).toContain(
      "[redacted-jwt]"
    );
  });

  it("caps a long validator dump", () => {
    translate("x".repeat(5_000));
    const logged = (errorMock.mock.calls[0]![1] as Error).message;
    expect(logged.length).toBeLessThan(500);
    expect(logged).toContain("[truncated]");
  });

  it("keeps the stack FRAMES but not the stack's message header", () => {
    // A stack string begins with `Error: <message>`. Copying the original
    // stack onto a redacted error puts the raw message straight back as line
    // one — the same leak, one field over. The frames are the useful half and
    // they point at our code, so they stay.
    const original = new Error("leaked sk_live_1234");
    original.stack =
      "Error: leaked sk_live_1234\n    at somewhereInThisServer\n    at alsoHere";
    translateConvexReadError(original, { scope: "v1.test" });

    const stack = (errorMock.mock.calls[0]![1] as Error).stack ?? "";
    expect(stack).not.toContain("sk_live_1234");
    expect(stack).toContain("sk_[redacted]");
    expect(stack).toContain("at somewhereInThisServer");
    expect(stack).toContain("at alsoHere");
  });

  it("falls back to its own stack when the original has no frames", () => {
    const original = new Error("boom");
    original.stack = "Error: boom";
    translateConvexReadError(original, { scope: "v1.test" });
    // Not empty, and not the original header.
    expect((errorMock.mock.calls[0]![1] as Error).stack).toBeTruthy();
  });

  it("passes a WebRouteError straight through", () => {
    const already = translate("boom");
    expect(translateConvexReadError(already, { scope: "v1.test" })).toBe(
      already
    );
  });
});
