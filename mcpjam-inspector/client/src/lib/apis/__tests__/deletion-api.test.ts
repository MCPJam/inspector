import { beforeEach, expect, it, vi } from "vitest";
const { request, get, authorize, cancel, authFetch } = vi.hoisted(() => ({
  request: vi.fn(),
  get: vi.fn(),
  authorize: vi.fn(),
  cancel: vi.fn(),
  authFetch: vi.fn(),
}));
vi.mock("@mcpjam/sdk/platform", () => ({
  PlatformApiClient: vi.fn().mockImplementation(function (config) {
    return {
      requestDeletion: request,
      getDeletion: get,
      authorizeDeletion: authorize,
      cancelDeletion: cancel,
      config,
    };
  }),
  isPlatformApiError: (error: { status?: number }) =>
    typeof error.status === "number",
}));
vi.mock("@/lib/session-token", () => ({ authFetch }));
import { readDeletion, startDeletion } from "../deletion-api";
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
it("keeps a request key after uncertain outcomes and reuses it on retry", async () => {
  request
    .mockRejectedValueOnce(new Error("Lost response"))
    .mockResolvedValueOnce({ requestId: "r1" });
  const scope = { type: "project" as const, id: "p1" };
  await expect(startDeletion(scope)).rejects.toThrow("Lost response");
  await startDeletion(scope);
  expect(request.mock.calls[0][1].idempotencyKey).toBe(
    request.mock.calls[1][1].idempotencyKey,
  );
});
it("only asks for a narrow receipt grant after an opaque not-found", async () => {
  get
    .mockRejectedValueOnce({ status: 404 })
    .mockResolvedValueOnce({ requestId: "r1" });
  await readDeletion("r1");
  expect(authorize).toHaveBeenCalledWith({ requestId: "r1" });
  get.mockRejectedValueOnce({ status: 503 });
  await expect(readDeletion("r2")).rejects.toEqual({ status: 503 });
  expect(authorize).toHaveBeenCalledTimes(1);
});
