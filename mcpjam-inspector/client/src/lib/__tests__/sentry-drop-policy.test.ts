import { ConvexError } from "convex/values";
import { expect, it } from "vitest";
import { createSentryDropPolicy } from "../sentry-drop-policy";
import { configureConvexQueryDiagnostics } from "../convex-query-diagnostics";

it.each(["forbidden", "unauthenticated", "session_revoked"])(
  "drops typed %s refusals while the original exception is present",
  (kind) => {
    const drop = createSentryDropPolicy("https://app.test");
    expect(drop({}, { originalException: new ConvexError({ kind }) })).toBe(
      true,
    );
    expect(drop({}, { originalException: new Error(kind) })).toBe(false);
  },
);

it("keeps source failures but drops the same injected-script patterns as the browser filter", () => {
  const drop = createSentryDropPolicy("https://app.test");
  const event = (filename: string) => ({
    exception: {
      values: [
        { stacktrace: { frames: [{ filename, function: "injected" }] } },
      ],
    },
  });
  expect(drop(event("https://app.test/p/project/chat"), {})).toBe(true);
  expect(drop(event("https://app.test/assets/app.js"), {})).toBe(false);
});

it("deduplicates query request IDs before strict reconstruction without mutating content", () => {
  configureConvexQueryDiagnostics("https://backend.convex.cloud");
  const drop = createSentryDropPolicy(undefined);
  const event = {
    exception: {
      values: [
        {
          value:
            "[CONVEX Q(private:query)] [Request ID: abc123] Server Error PRIVATE_SENTINEL",
        },
      ],
    },
  };
  const before = structuredClone(event);
  expect(drop(event, {})).toBe(false);
  expect(drop(event, {})).toBe(true);
  expect(event).toEqual(before);
  expect(
    drop({ ...event, tags: { convex_backend: "other.convex.cloud" } }, {}),
  ).toBe(false);
});
