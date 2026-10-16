import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ key: "actual-key", enabled: true }));
vi.mock("../../../../config.js", () => ({
  HOSTED_MODE: false,
  get LOCAL_HARNESS_ENABLED() {
    return state.enabled;
  },
}));
vi.mock("../grants.js", () => ({
  getLocalMachineId: async () => "actual-machine",
}));
vi.mock("../instance-key.js", () => ({
  readLocalInstanceIdentity: async () => ({ keyId: state.key }),
  getRegisteredKeyId: () => null,
}));
import { localStudyRuntimeProof } from "../study-runtime-proof.js";
beforeEach(() => {
  state.key = "actual-key";
  state.enabled = true;
});
it("ignores caller machine and key while forwarding an opaque reservation", async () => {
  expect(
    await localStudyRuntimeProof(
      {
        localStudySessionId: "reservation",
        machineId: "forged",
        keyId: "forged",
      },
      "chat",
    ),
  ).toEqual({
    localStudySessionId: "reservation",
    machineId: "actual-machine",
    keyId: "actual-key",
    chatSessionId: "chat",
  });
});
it("leaves ordinary runtime reads unchanged", async () => {
  expect(await localStudyRuntimeProof(undefined, "chat")).toBeUndefined();
});
it("refuses missing registration, malformed identity and disabled server", async () => {
  await expect(
    localStudyRuntimeProof({ localStudySessionId: "reservation" }, undefined),
  ).rejects.toThrow("Authorize");
  state.key = "";
  await expect(
    localStudyRuntimeProof({ localStudySessionId: "reservation" }, "chat"),
  ).rejects.toThrow("Authorize");
  state.enabled = false;
  await expect(
    localStudyRuntimeProof({ localStudySessionId: "reservation" }, "chat"),
  ).rejects.toThrow("unavailable");
});
