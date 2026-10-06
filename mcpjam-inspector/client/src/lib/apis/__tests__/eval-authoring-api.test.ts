import { beforeEach, describe, expect, it, vi } from "vitest";

const authFetchMock = vi.fn();

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader: vi.fn(async () => "Bearer token"),
}));

import { authoringRequest } from "../eval-authoring-api";

function respond(status: number, body: unknown) {
  authFetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("authoringRequest", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
  });

  it("surfaces the message from the inspector's error envelope", async () => {
    // The inspector route answers `{ code, message }`, with no `error` key.
    respond(400, {
      code: "VALIDATION_ERROR",
      message: "This suite has multiple environments; name the one to use.",
    });
    await expect(
      authoringRequest({ operation: "status", jobId: "job-1" }),
    ).rejects.toMatchObject({
      message: "This suite has multiple environments; name the one to use.",
      status: 400,
    });
  });

  it("surfaces an error string passed through from Convex", async () => {
    respond(403, {
      code: "credential_not_allowed",
      error: "Sign in to MCPJam in the Inspector to author cases.",
    });
    await expect(
      authoringRequest({ operation: "status", jobId: "job-1" }),
    ).rejects.toMatchObject({
      message: "Sign in to MCPJam in the Inspector to author cases.",
      status: 403,
    });
  });

  it("falls back to a generic sentence when the body names nothing", async () => {
    respond(500, {});
    await expect(
      authoringRequest({ operation: "status", jobId: "job-1" }),
    ).rejects.toMatchObject({ message: "Case authoring failed.", status: 500 });
  });

  it("names the service, not the parser, when a gateway answers with HTML", async () => {
    authFetchMock.mockResolvedValueOnce(
      new Response("<html>bad gateway</html>", { status: 502 }),
    );
    await expect(
      authoringRequest({ operation: "status", jobId: "job-1" }),
    ).rejects.toMatchObject({
      message: "The case authoring service is unavailable. Please try again.",
      status: 502,
    });
  });

  it("keeps a cancellation during the body read as the abort", async () => {
    const controller = new AbortController();
    const abort = new DOMException("The operation was aborted.", "AbortError");
    authFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => {
        controller.abort();
        return Promise.reject(abort);
      },
    });
    await expect(
      authoringRequest(
        { operation: "status", jobId: "job-1" },
        controller.signal,
      ),
    ).rejects.toBe(abort);
  });

  it("refuses an unreadable body on a 2xx instead of returning null", async () => {
    authFetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    await expect(
      authoringRequest({ operation: "status", jobId: "job-1" }),
    ).rejects.toMatchObject({
      message: "The case authoring service is unavailable. Please try again.",
      status: 200,
    });
  });
});
