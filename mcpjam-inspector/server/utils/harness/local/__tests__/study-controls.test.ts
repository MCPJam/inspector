import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ actor: vi.fn(), revoke: vi.fn(), cleanup: vi.fn(), runtime: vi.fn(), rollout: vi.fn() }));
vi.mock("../../../../config.js", () => ({ HOSTED_MODE: false }));
vi.mock("../acting-user.js", () => ({ resolveLocalHarnessActor: mock.actor }));
vi.mock("../study-access.js", () => ({ revokeLocalStudyReservation: mock.revoke }));
vi.mock("../study-workspace.js", () => ({ cleanupLocalStudyWorkspace: mock.cleanup }));
vi.mock("../../../scenario-runtime-config.js", () => ({ fetchScenarioRuntimeConfig: mock.runtime }));
vi.mock("../readiness.js", () => ({ localHarnessAccountEnabled: mock.rollout }));
import { localStudyAvailability, revokeLocalStudy } from "../study-controls.js";
beforeEach(() => {
  vi.clearAllMocks();
  mock.actor.mockResolvedValue({ ok: true, actor: { userId: "actual-actor" } });
  mock.revoke.mockResolvedValue({ reservationId: "reservation", projectId: "canonical-project", scenarioId: "canonical-study", chatSessionId: "canonical-chat", accessVersion: 2, expiresAt: 0 });
  mock.cleanup.mockResolvedValue(true);
  mock.rollout.mockResolvedValue(true);
});
it("cleans only the backend-owned scope even after expiry", async () => {
  expect(await revokeLocalStudy({ bearer: "token", reservationId: "reservation" })).toEqual({ revoked: true, cleanupComplete: true });
  expect(mock.cleanup).toHaveBeenCalledWith({ userId: "actual-actor", projectId: "canonical-project", study: { scenarioId: "canonical-study", chatSessionId: "canonical-chat", accessVersion: 2 } });
});
it("reports an unconfirmed stop without claiming cleanup", async () => {
  mock.cleanup.mockResolvedValue(false);
  expect(await revokeLocalStudy({ bearer: "token", reservationId: "reservation" })).toEqual({ revoked: true, cleanupComplete: false });
});
it("refuses unverified actors before revocation or filesystem access", async () => {
  mock.actor.mockResolvedValue({ ok: false, message: "Sign in" });
  await expect(revokeLocalStudy({ bearer: "guest", reservationId: "reservation" })).rejects.toThrow("Sign in");
  expect(mock.revoke).not.toHaveBeenCalled(); expect(mock.cleanup).not.toHaveBeenCalled();
});
it.each([undefined, { harnessId: "codex" }, { harnessId: "other", modelSourceReady: true }])("does not offer local from missing/malformed metadata", async (localStudyAdmission) => {
  mock.runtime.mockResolvedValue({ ok: true, config: { localStudyAdmission } });
  expect(await localStudyAvailability({ bearer: "token", scenarioId: "study", accessVersion: 2 })).toBeNull();
});
it("requires the actual client's rollout for advisory discovery", async () => {
  mock.runtime.mockResolvedValue({ ok: true, config: { localStudyAdmission: { harnessId: "codex", modelSourceReady: true } } });
  mock.rollout.mockResolvedValue(false);
  expect(await localStudyAvailability({ bearer: "token", scenarioId: "study", accessVersion: 2 })).toBeNull();
});
