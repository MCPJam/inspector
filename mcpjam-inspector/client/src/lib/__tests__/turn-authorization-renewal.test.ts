import { afterEach, expect, it, vi } from "vitest";
import { createTurnAuthorizationRenewal } from "../turn-authorization-renewal";
const requestId = "f56e90a1-dc58-443e-85b0-14677744b9b3";
const part = () => ({ type: "data-turn-authorization", data: {
  handle: "f56e90a1-dc58-443e-85b0-14677744b9b4", projectId: "project", chatSessionId: "chat", turnId: "turn", requestId,
  expiresAt: Date.now() + 120_000, tokenExpiresAt: Date.now() + 300_000,
} });
afterEach(() => vi.useRealTimers());
it("renews only credentials, serially, and aborts on terminal cleanup", async () => {
  vi.useFakeTimers(); let release!: (value: Response) => void;
  const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => { release = resolve; }));
  const loop = createTurnAuthorizationRenewal(() => ({ chatSessionId: "chat", requestId }), fetcher);
  const event = part(); expect(loop.accept(event)).toBe(true); loop.accept(event);
  await vi.advanceTimersByTimeAsync(90_000); expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/mcp/turn-authorization");
  release(Response.json({ renewed: true })); await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(1); // Deadline reached before the next request.
  loop.stop(); expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});
it("does not renew a foreign chat or stale request generation", () => {
  const fetcher = vi.fn(); const loop = createTurnAuthorizationRenewal(() => ({ chatSessionId: "chat", requestId }), fetcher);
  const event = part(); loop.accept({ ...event, data: { ...event.data, chatSessionId: "other" } });
  loop.accept({ ...event, data: { ...event.data, requestId: "f56e90a1-dc58-443e-85b0-14677744b9b5" } });
  expect(fetcher).not.toHaveBeenCalled();
});
it("ends a loop when the active generation changes, without any model submission", async () => {
  vi.useFakeTimers(); let currentId = requestId;
  const fetcher = vi.fn(async () => Response.json({ renewed: true }));
  const loop = createTurnAuthorizationRenewal(() => ({ chatSessionId: "chat", requestId: currentId }), fetcher);
  loop.accept(part()); await vi.advanceTimersByTimeAsync(1); currentId = "next";
  await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).toHaveBeenCalledOnce(); loop.stop();
});
it("stops on refusal and retries transient renewal failures without overlapping", async () => {
  vi.useFakeTimers(); const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValue(new Response(null, { status: 401 }));
  const loop = createTurnAuthorizationRenewal(() => ({ chatSessionId: "chat", requestId }), fetcher);
  loop.accept(part()); await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).toHaveBeenCalledTimes(2); loop.stop();
});
