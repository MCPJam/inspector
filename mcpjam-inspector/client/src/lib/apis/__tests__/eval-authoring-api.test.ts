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

  it("keeps the generic message for the inspector's error envelope", async () => {
    // The inspector route answers `{ code, message }`, with no `error` key.
    respond(400, {
      code: "VALIDATION_ERROR",
      message: "This suite has multiple environments; name the one to use.",
    });
    await expect(
      authoringRequest({ operation: "status", jobId: "job-1" }),
    ).rejects.toMatchObject({
      message: "Case authoring failed.",
      status: 400,
    });
  });

  it("surfaces an error string passed through from Convex", async () => {
    respond(403, {
      error: "An authorized inspector must capture the tool snapshot.",
    });
    await expect(
      authoringRequest({ operation: "status", jobId: "job-1" }),
    ).rejects.toMatchObject({
      message: "An authorized inspector must capture the tool snapshot.",
      status: 403,
    });
  });

  it("falls back to a generic sentence when the body names nothing", async () => {
    respond(500, {});
    await expect(
      authoringRequest({ operation: "status", jobId: "job-1" }),
    ).rejects.toMatchObject({ message: "Case authoring failed.", status: 500 });
  });
});
