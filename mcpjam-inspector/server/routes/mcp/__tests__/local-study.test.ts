import { beforeEach, expect, it, vi } from "vitest";
const setup = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/harness/local/study-readiness.js", () => ({
  setupLocalStudyPreview: setup,
}));
vi.mock("../../../utils/harness/local/readiness.js", () => ({
  LocalRuntimePreparingError: class extends Error {},
}));
vi.mock("../../../middleware/origin-validation.js", () => ({
  isAllowedRequestOrigin: (origin: string) =>
    origin === "http://localhost:6274",
}));
import localStudy from "../local-study.js";
import { LocalRuntimePreparingError } from "../../../utils/harness/local/readiness.js";

const body = {
  accepted: true,
  scenarioId: "study",
  accessVersion: 2,
  chatSessionId: "chat",
};
const request = (payload: unknown = body, origin = "http://localhost:6274") =>
  localStudy.request("/setup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer identity",
      Origin: origin,
    },
    body: JSON.stringify(payload),
  });
beforeEach(() => {
  setup.mockReset();
  setup.mockResolvedValue({
    target: {
      kind: "local-native",
      grantToken: "secret",
      actingUserId: "actor",
      study: {},
      localSessionId: "internal",
      localStudySessionId: "reservation",
    },
    harnessId: "codex",
    expiresAt: "expiry",
    workspaceDisplayRoot: "~/study",
    reservation: { reservationId: "reservation" },
  });
});
it("returns opaque study target and a separate header capability", async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(setup).toHaveBeenCalledWith({ ...body, bearer: "identity" });
  expect(await response.json()).toEqual({
    state: "ready",
    token: "secret",
    target: {
      kind: "local-native",
      harnessId: "codex",
      localStudySessionId: "reservation",
    },
    expiresAt: "expiry",
    workspaceDisplayRoot: "~/study",
    reservation: { reservationId: "reservation" },
  });
});
it.each([
  { ...body, accepted: false },
  { ...body, accessVersion: -1 },
  { ...body, chatSessionId: "" },
  { ...body, projectId: "substitute" },
])("rejects invalid or caller-owned authority fields", async (payload) => {
  expect((await request(payload)).status).toBe(400);
  expect(setup).not.toHaveBeenCalled();
});
it("rejects a foreign origin before setup", async () => {
  expect((await request(body, "https://attacker.example")).status).toBe(403);
  expect(setup).not.toHaveBeenCalled();
});
it("reports installing without a credential or automatic retry", async () => {
  setup.mockRejectedValue(new LocalRuntimePreparingError("installing"));
  const response = await request();
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ state: "installing" });
});
it("preserves actionable authorization errors", async () => {
  setup.mockRejectedValue(
    new Error(
      "Choose and save a model source for this client before running locally.",
    ),
  );
  const response = await request();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: expect.stringContaining("Choose and save"),
  });
});
it("rejects malformed JSON", async () => {
  const response = await localStudy.request("/setup", {
    method: "POST",
    headers: { Origin: "http://localhost:6274" },
    body: "{",
  });
  expect(response.status).toBe(400);
  expect(setup).not.toHaveBeenCalled();
});
