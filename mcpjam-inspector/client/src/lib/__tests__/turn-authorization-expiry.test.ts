import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
import { setApiContext, getApiAuthorizationHeader, resetTokenCache } from "../apis/web/context";
import { createTurnAuthorizationRenewal } from "../turn-authorization-renewal";
import { resetSessionRevokedForTests } from "../auth/session-revoked";

afterEach(() => { setApiContext(null); resetTokenCache(); resetSessionRevokedForTests(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("refreshes before expiry despite the30second cache and10second automatic refresh buffer", async () => {
  vi.useFakeTimers();
  const expiresAt = Date.now() + 300_000;
  let refreshed = false;
  const getAccessToken = vi.fn(async (options?: { forceRefresh?: boolean }) => {
    if (options?.forceRefresh || Date.now() >= expiresAt - 10_000) refreshed = true;
    return refreshed ? "fresh-token" : "initial-token";
  });
  setApiContext({ projectId: "project", isAuthenticated: true, hasSession: true, getAccessToken });
  expect(await getApiAuthorizationHeader()).toBe("Bearer initial-token");
  const sent: Array<{ at: number; bearer: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const bearer = new Headers(init?.headers).get("authorization");
    sent.push({ at: Date.now(), bearer });
    return Response.json({ renewed: true, tokenExpiresAt: bearer === "Bearer fresh-token" ? Date.now() + 300_000 : expiresAt });
  }));
  const requestId = "f56e90a1-dc58-443e-85b0-14677744b9b3";
  const renewal = createTurnAuthorizationRenewal(() => ({ chatSessionId: "chat", requestId }));
  renewal.accept({ type: "data-turn-authorization", data: {
    handle: "f56e90a1-dc58-443e-85b0-14677744b9b4", projectId: "project", chatSessionId: "chat", turnId: "turn", requestId,
    expiresAt: Date.now() + 600_000, tokenExpiresAt: expiresAt,
  } });
  await vi.advanceTimersByTimeAsync(270_000);
  expect(getAccessToken).toHaveBeenCalledWith({ forceRefresh: true });
  const firstFresh = sent.find((request) => request.bearer === "Bearer fresh-token");
  expect(firstFresh?.at).toBeLessThanOrEqual(expiresAt - 30_000);
  expect(sent.every((request) => request.at < expiresAt || request.bearer === "Bearer fresh-token")).toBe(true);
  renewal.stop();
});
