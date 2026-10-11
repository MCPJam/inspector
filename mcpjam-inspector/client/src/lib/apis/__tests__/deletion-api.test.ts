import { beforeEach, expect, it, vi } from "vitest";
const { request, get, authorize, cancel, authFetch, me, capabilities } = vi.hoisted(() => ({
  me: vi.fn(),
  capabilities: vi.fn(),
  request: vi.fn(),
  get: vi.fn(),
  authorize: vi.fn(),
  cancel: vi.fn(),
  authFetch: vi.fn(),
}));
vi.mock("@mcpjam/sdk/platform", () => ({
  PlatformApiClient: vi.fn().mockImplementation(function (config) {
    return {
      getMe: me,
      getDeletionCapabilities: capabilities,
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
import { readDeletion, startDeletion, deleteScope, recoverDeletion, DeletionOutcomeUnknown } from "../deletion-api";
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  me.mockResolvedValue({ id: "actor1" });
  capabilities.mockResolvedValue({ available: true });
});
it("keeps a request key after uncertain outcomes and reuses it on retry", async () => {
  request
    .mockRejectedValueOnce({ status: 0 })
    .mockResolvedValueOnce({ requestId: "r1" });
  const scope = { type: "project" as const, id: "p1" };
  await expect(startDeletion(scope)).rejects.toBeInstanceOf(DeletionOutcomeUnknown);
  await recoverDeletion("?type=project&id=p1", async () => "token");
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

it("preserves legacy behavior only before explicit unavailable negotiation", async () => {
  capabilities.mockResolvedValue({ available: false });
  const legacy = vi.fn().mockResolvedValue(undefined);
  expect(await deleteScope({ type: "organization", id: "o1" }, legacy)).toBe(true);
  expect(legacy).toHaveBeenCalledOnce();
  expect(request).not.toHaveBeenCalled();
});
it("never falls back after uncertainty even if availability changes", async () => {
  request.mockRejectedValueOnce({ status: 503 }).mockResolvedValueOnce({ requestId: "r1" });
  const scope = { type: "project" as const, id: "p1" };
  await expect(startDeletion(scope)).rejects.toBeInstanceOf(DeletionOutcomeUnknown);
  capabilities.mockResolvedValue({ available: false });
  const legacy = vi.fn();
  await deleteScope(scope, legacy);
  expect(legacy).not.toHaveBeenCalled();
  expect(capabilities).not.toHaveBeenCalled();
});
it("recovery cannot create a new request or replay another actor's key", async () => {
  await expect(recoverDeletion("?type=project&id=p1", async () => "token")).rejects.toThrow("No pending");
  request.mockRejectedValueOnce({ status: 0 });
  await expect(startDeletion({ type: "project", id: "p1" })).rejects.toBeInstanceOf(DeletionOutcomeUnknown);
  me.mockResolvedValue({ id: "actor2" });
  await expect(recoverDeletion("?type=project&id=p1", async () => "token")).rejects.toThrow("No pending");
  expect(request).toHaveBeenCalledTimes(1);
});
it("capability failures do not trigger legacy deletion", async () => {
  capabilities.mockRejectedValueOnce(new Error("Unavailable"));
  const legacy = vi.fn();
  await expect(deleteScope({ type: "project", id: "p1" }, legacy)).rejects.toThrow("Unavailable");
  expect(legacy).not.toHaveBeenCalled();
});

it("does not silently change the protocol confirmed in the dialog", async () => {
  capabilities.mockResolvedValue({ available: false });
  const legacy = vi.fn();
  await expect(deleteScope({ type: "organization", id: "o1" }, legacy, true)).rejects.toThrow("availability changed");
  expect(legacy).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
