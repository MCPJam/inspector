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
    // The user-testing reads authorize at WORKSPACE scope; before these
    // wordings were matched, a cross-workspace probe answered 502 — a paging
    // Sentry event and an existence oracle (404 = missing, 502 = exists).
    "Not a member of this workspace",
    "Insufficient workspace permissions: requires member",
    // `resolveAuthorizedChatSession`'s refusal, same oracle on session ids.
    "ChatSession not found or unauthorized",
    // The same helper family on every other resource. Matched on the compound
    // phrase rather than per-resource: `evals.ts` moved onto this translator
    // and its reads refuse in exactly these words, and an enumeration would
    // have answered 502 — and paged — for each resource nobody added.
    "Suite not found or unauthorized",
    "Test suite run not found or unauthorized",
  ])("reads %s as a membership refusal", (message) => {
    expect(classifyConvexReadError(new Error(message)).kind).toBe("membership");
  });

  it("reads an ArgumentValidationError as invalid-argument", () => {
    // A caller-shaped id `v.id(...)` rejected before the handler ran. Not an
    // incident — classifying it upstream turned every stale-id retry loop
    // into a stream of 5xx Sentry events.
    expect(
      classifyConvexReadError(
        new Error("ArgumentValidationError: Value does not match validator")
      ).kind
    ).toBe("invalid-argument");
  });

  it("reads production's redacted 'Server Error' as its own kind", () => {
    // Production Convex collapses plain server-side errors — membership
    // refusals included — to this string. Only the call site knows whether
    // 404 or 502 is the safe reading, so it is neither by default.
    expect(
      classifyConvexReadError(new Error("[Request ID: abc] Server Error")).kind
    ).toBe("redacted");
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

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an Error with no message", new Error("")],
    ["a thrown string", "boom"],
  ])("falls back to upstream for %s", (_label, thrown) => {
    // The signature takes `unknown`, so these are reachable inputs, and the
    // fallback has to be the CAUTIOUS one. Any of them landing in `membership`
    // would answer 404 — telling a caller their resource is gone on the
    // strength of an error we could not read at all.
    expect(classifyConvexReadError(thrown).kind).toBe("upstream");
  });

  it("does NOT read a bare 'not found' as membership", () => {
    // A renamed or undeployed Convex function says this. Calling it membership
    // would answer 404 — telling a caller their resource is gone during an
    // outage of ours. The compound "not found or unauthorized" above is a
    // refusal; these words apart are not.
    expect(
      classifyConvexReadError(new Error("journeys:nope not found")).kind
    ).toBe("upstream");
    expect(
      classifyConvexReadError(
        new Error("Could not find public function for testSuites:getTestSuite")
      ).kind
    ).toBe("upstream");
  });

  it("cannot see an ArgumentValidationError through prod's redaction", () => {
    // The finding behind the eval-run id gate, pinned so it stops being
    // folklore. In production, Convex rejecting `v.id("testSuiteRun")` arrives
    // as this — verbatim from Axiom `inspector-logs`, request 182db601667cf972
    // — with the validator text already stripped. So this classifier answers
    // `redacted`, and a post-preflight read turns that into 502 and a page. No
    // amount of message-matching here fixes the malformed-id case; only a shape
    // check BEFORE the call does. See `convex-id-param.ts`.
    const redacted = new Error("[Request ID: 182db601667cf972] Server Error");

    expect(classifyConvexReadError(redacted).kind).toBe("redacted");
    expect(
      translateConvexReadError(redacted, {
        scope: "v1.evals",
        notFoundMessage: "Eval run not found",
      }).status
    ).toBe(502);
  });
});

describe("translateConvexReadError", () => {
  it("maps the kinds to 404 / 401 / 502", () => {
    expect(translate("Not a member of this project").status).toBe(404);
    expect(translate("token expired").status).toBe(401);
    expect(translate("boom").status).toBe(502);
  });

  it("answers 502 to an unreadable throw rather than guessing", () => {
    // `null` and a message-less Error are both reachable through the `unknown`
    // signature. 502 is the honest answer — we do not know what happened, and
    // the alternative reading (404) would report a resource as gone.
    expect(translateConvexReadError(null, { scope: "v1.test" }).status).toBe(
      502
    );
    expect(
      translateConvexReadError(new Error(""), { scope: "v1.test" }).status
    ).toBe(502);
  });

  it("answers 404 to a validator-rejected argument, without logging", () => {
    const err = translateConvexReadError(
      new Error("ArgumentValidationError: Value does not match validator"),
      { scope: "v1.test", notFoundMessage: "Scenario not found" }
    );
    expect(err.status).toBe(404);
    expect(err.message).toBe("Scenario not found");
    // Not an incident: a malformed caller id must not page anyone.
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("answers 502 to a redacted 'Server Error' by default", () => {
    // Post-preflight reads: a redacted error there is a genuine incident, and
    // 404 would hide it.
    expect(translate("[Request ID: abc] Server Error").status).toBe(502);
  });

  it("answers 404 to a redacted 'Server Error' when the call site is a preflight", () => {
    const err = translateConvexReadError(
      new Error("[Request ID: abc] Server Error"),
      {
        scope: "v1.test",
        notFoundMessage: "Scenario not found",
        redactedIsRefusal: true,
      }
    );
    expect(err.status).toBe(404);
    expect(err.message).toBe("Scenario not found");
    // And SILENTLY. A cross-workspace probe is someone typing an id they do
    // not have access to; paging on each one turns a routine refusal into an
    // alert stream, which is how the real incidents get lost.
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("still answers 502 to a network failure even at a preflight", () => {
    // An outage must not read as mass deletion: `redactedIsRefusal` covers
    // only the shape production redaction produces, never transport errors.
    const err = translateConvexReadError(new Error("fetch failed"), {
      scope: "v1.test",
      redactedIsRefusal: true,
    });
    expect(err.status).toBe(502);
  });

  it("never puts upstream text in the 502 RESPONSE", () => {
    const err = translate("upstream exploded: secret-arg-value");
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
      // A bearer behind a header NAME is redacted by the key=value rule, which
      // swallows the `Bearer ` prefix so the two rules cannot both fire and
      // leave `authorization=[redacted] [redacted]`. A standalone `Bearer x`
      // still reads `Bearer [redacted]` — see redact-log-message.test.ts.
      expect(seen).toContain("Authorization=[redacted]");
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
