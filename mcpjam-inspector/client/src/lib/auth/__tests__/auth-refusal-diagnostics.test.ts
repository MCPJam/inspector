import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAuthRefusalDiagnostics } from "../auth-refusal-diagnostics";
import { createConvexQueryEventProcessor } from "../../convex-query-diagnostics";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it("groups a burst, records only safe request IDs, and emits once on recovery", () => {
  const send = vi.fn();
  const d = createAuthRefusalDiagnostics(send);
  d.update({ mode: "guest", authenticated: true, ready: true, epoch: 1 });
  for (let i = 0; i < 30; i++)
    d.record(
      "unauthenticated",
      `[CONVEX Q(billing:read)] [Request ID: ${i.toString(16)}] SECRET arguments`,
      "billing:read",
      "dev.convex.cloud",
    );
  d.update({ ready: false, blocked: true });
  d.update({ authenticated: true, ready: true, blocked: false, epoch: 2 });
  d.flush();
  vi.advanceTimersByTime(20_000);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].failures).toHaveLength(20);
  expect(send.mock.calls[0][0].outcome).toBe("recovered");
  expect(JSON.stringify(send.mock.calls)).not.toContain("SECRET");
});
it("reports unresolved episodes once, and logging cannot throw into recovery", () => {
  const send = vi.fn(() => {
    throw Error("offline");
  });
  const d = createAuthRefusalDiagnostics(send);
  d.record("session_revoked", "secret", "hosts:listHosts");
  expect(() => vi.advanceTimersByTime(15_000)).not.toThrow();
  d.record("session_revoked", "secret", "hosts:listHosts");
  d.flush();
  expect(send).toHaveBeenCalledTimes(1);
});
it("strips inherited Sentry credentials, user details and breadcrumbs", () => {
  const event = createConvexQueryEventProcessor()({
    type: undefined,
    tags: { source: "convex_auth_refusal", auth_refusal_id: "episode" },
    user: { email: "SECRET" },
    request: { headers: { authorization: "SECRET" } },
    breadcrumbs: [{ message: "SECRET" }],
    extra: { args: "SECRET" },
    contexts: {
      auth_refusal: { outcome: "recovered" },
      replay: { url: "SECRET" },
    },
  });
  expect(JSON.stringify(event)).not.toContain("SECRET");
  expect(event?.level).toBe("info");
  expect(event?.contexts?.auth_refusal?.outcome).toBe("recovered");
});
