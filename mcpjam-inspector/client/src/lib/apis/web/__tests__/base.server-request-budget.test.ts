import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetchMock = vi.fn();

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
  addTokenToUrl: vi.fn((url: string) => url),
}));

import { webPost, WebApiError } from "../base";
import { SERVER_REQUEST_BUDGET_REASON } from "@/shared/server-request-budget";

/**
 * MJ-012: a refusal from the per-server request budget on the hosted MCP
 * operation routes is retried after the wait it names — a bounded number of
 * times, abortable, and only when it carries that budget's marker. Every other
 * 429 throws exactly as before.
 *
 * Only `setTimeout` is faked, so a wait passes only when a test moves the clock.
 */

/** A 429 shaped like the budget's own; `null` leaves a field out. */
function budgetRefusal(
  retryAfter: string | null = "1",
  details: Record<string, unknown> | null = {
    reason: SERVER_REQUEST_BUDGET_REASON,
  },
): Response {
  return new Response(
    JSON.stringify({
      code: "RATE_LIMITED",
      message: "Too many requests to this server. Slow down and retry.",
      ...(details === null ? {} : { details }),
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        ...(retryAfter === null ? {} : { "Retry-After": retryAfter }),
      },
    },
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Let the pending fetch and body read settle without moving the clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("webPost — per-server request budget refusals", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a marked 429 after its Retry-After, then resolves", async () => {
    authFetchMock
      .mockResolvedValueOnce(budgetRefusal("1"))
      .mockResolvedValueOnce(jsonResponse({ tools: [{ name: "echo" }] }));

    const call = webPost("/api/web/tools/list", {
      projectId: "project-1",
      serverId: "srv-1",
    });

    await settle();
    await vi.advanceTimersByTimeAsync(999);
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(call).resolves.toEqual({ tools: [{ name: "echo" }] });
    expect(authFetchMock).toHaveBeenCalledTimes(2);
    // The retry is the same request, sent again.
    expect(authFetchMock.mock.calls[1]).toEqual(authFetchMock.mock.calls[0]);
  });

  it.each([
    ["no details", null],
    ["another reason", { reason: "something-else" }],
  ])("throws a 429 with %s immediately", async (_label, details) => {
    authFetchMock.mockResolvedValueOnce(budgetRefusal("1", details));

    await expect(
      webPost("/api/web/tools/list", { serverId: "srv-1" }),
    ).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["above the bound", "6"],
    ["missing", null],
    ["an HTTP date", "Wed, 21 Oct 2026 07:28:00 GMT"],
    ["negative", "-1"],
  ])(
    "throws a marked 429 whose Retry-After is %s immediately",
    async (_label, retryAfter) => {
      authFetchMock.mockResolvedValueOnce(budgetRefusal(retryAfter));

      const error = await webPost("/api/web/tools/list", {
        serverId: "srv-1",
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(WebApiError);
      expect(error).toMatchObject({
        status: 429,
        details: { reason: SERVER_REQUEST_BUDGET_REASON },
      });
      expect(authFetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not retry the marker on a status other than 429", async () => {
    authFetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          code: "INTERNAL_ERROR",
          message: "boom",
          details: { reason: SERVER_REQUEST_BUDGET_REASON },
        },
        500,
      ),
    );

    await expect(
      webPost("/api/web/tools/list", { serverId: "srv-1" }),
    ).rejects.toMatchObject({ status: 500 });
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects as soon as the signal aborts during the wait", async () => {
    authFetchMock.mockResolvedValueOnce(budgetRefusal("5"));
    const controller = new AbortController();

    const call = webPost(
      "/api/web/tools/execute",
      { serverId: "srv-1", toolName: "echo" },
      { signal: controller.signal },
    );
    const outcome = call.catch((caught: unknown) => caught);

    await settle();
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();

    const error = await outcome;
    expect(error).toMatchObject({ name: "AbortError" });
    // Nothing is left waiting, and the request was never sent again.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not wait at all when the signal is already aborted", async () => {
    authFetchMock.mockResolvedValueOnce(budgetRefusal("1"));
    const controller = new AbortController();
    controller.abort();

    await expect(
      webPost(
        "/api/web/tools/list",
        { serverId: "srv-1" },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after three retries and throws the last refusal", async () => {
    authFetchMock.mockImplementation(async () => budgetRefusal("1"));

    const outcome = webPost("/api/web/tools/list", {
      serverId: "srv-1",
    }).catch((caught: unknown) => caught);
    for (let i = 0; i < 10; i++) {
      await settle();
      await vi.advanceTimersByTimeAsync(1_000);
    }

    const error = await outcome;
    expect(error).toBeInstanceOf(WebApiError);
    expect(error).toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      details: { reason: SERVER_REQUEST_BUDGET_REASON },
    });
    // The first attempt plus three retries.
    expect(authFetchMock).toHaveBeenCalledTimes(4);
  });

  it("gives each call its own retries", async () => {
    authFetchMock
      .mockResolvedValueOnce(budgetRefusal("1"))
      .mockResolvedValueOnce(jsonResponse({ page: 1 }))
      .mockResolvedValueOnce(budgetRefusal("1"))
      .mockResolvedValueOnce(budgetRefusal("1"))
      .mockResolvedValueOnce(budgetRefusal("1"))
      .mockResolvedValueOnce(jsonResponse({ page: 2 }));

    const first = webPost("/api/web/tools/list", { serverId: "srv-1" });
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toEqual({ page: 1 });

    const second = webPost("/api/web/tools/list", {
      serverId: "srv-1",
      cursor: "2",
    });
    for (let i = 0; i < 3; i++) {
      await settle();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await expect(second).resolves.toEqual({ page: 2 });
    expect(authFetchMock).toHaveBeenCalledTimes(6);
  });
});
