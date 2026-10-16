import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  reserve: vi.fn(),
  ready: vi.fn(),
  workspace: vi.fn(),
  member: vi.fn(),
}));
vi.mock("../../../scenario-runtime-config.js", () => ({
  fetchScenarioRuntimeConfig: mocks.config,
}));
vi.mock("../../harness-model-broker.js", () => ({
  registerLocalInstance: async () => ({ ok: true, keyId: "key" }),
}));
vi.mock("../grants.js", () => ({ getLocalMachineId: async () => "machine" }));
vi.mock("../instance-key.js", () => ({
  readLocalInstanceIdentity: async () => ({ publicKey: "public" }),
  setRegisteredKeyId: vi.fn(),
}));
vi.mock("../readiness.js", () => ({
  ensureLocalHarnessTarget: mocks.ready,
  verifyLocalHarnessMember: mocks.member,
}));
vi.mock("../run-resources.js", () => ({
  localHarnessIdOf: (id: string) =>
    ["claude-code", "codex"].includes(id) ? id : null,
}));
vi.mock("../study-access.js", () => ({
  requestLocalStudyReservation: mocks.reserve,
}));
vi.mock("../study-workspace.js", () => ({
  prepareLocalStudyWorkspace: mocks.workspace,
}));
import { setupLocalStudyPreview } from "../study-readiness.js";

const args = {
  bearer: "bearer",
  scenarioId: "study",
  accessVersion: 2,
  chatSessionId: "chat",
};
const config = {
  scenarioId: "study",
  accessVersion: 2,
  harness: "codex",
  modelSelection: {
    source: "hosted",
    modelId: "openai/gpt-5",
    fallback: { model: "none", provider: "none" },
  },
  accessKind: "project_member",
  actorKind: "signedIn",
  executionScope: { kind: "project", projectId: "canonical-project" },
  requireToolApproval: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.mockResolvedValue({ ok: true, config });
  mocks.member.mockResolvedValue({ userId: "actual-user" });
  mocks.reserve.mockResolvedValue({
    reservationId: "reservation",
    projectId: "canonical-project",
    ...args,
  });
  mocks.workspace.mockResolvedValue({
    workspaceGrantId: "private-workspace",
    localSessionId: "local-study",
  });
  mocks.ready.mockResolvedValue({ target: { grantToken: "grant" } });
});

it("derives the member, project and client before minting a separate study grant", async () => {
  const result = await setupLocalStudyPreview(args);
  expect(mocks.member).toHaveBeenCalledWith(
    "bearer",
    "canonical-project",
    undefined,
    "codex",
  );
  expect(mocks.workspace).toHaveBeenCalledWith({
    userId: "actual-user",
    projectId: "canonical-project",
    study: { scenarioId: "study", accessVersion: 2, chatSessionId: "chat" },
  });
  expect(mocks.ready).toHaveBeenCalledWith(
    expect.objectContaining({
      harnessId: "codex",
      scope: "attended",
      workspaceGrantId: "private-workspace",
      localStudySessionId: "reservation",
      study: { scenarioId: "study", accessVersion: 2, chatSessionId: "chat" },
    }),
  );
  expect(result.target).toEqual({
    grantToken: "grant",
    localSessionId: "local-study",
  });
});

it.each([
  { accessKind: "swarm_grant" },
  { actorKind: "guest" },
  { harness: "other" },
  { scenarioId: "other" },
  { accessVersion: 3 },
])("refuses incompatible study context %j", async (change) => {
  mocks.config.mockResolvedValue({
    ok: true,
    config: { ...config, ...change },
  });
  await expect(setupLocalStudyPreview(args)).rejects.toThrow(
    "Local study preview",
  );
  expect(mocks.reserve).not.toHaveBeenCalled();
  expect(mocks.ready).not.toHaveBeenCalled();
});

it.each([
  { projectId: "other" },
  { scenarioId: "other" },
  { chatSessionId: "other" },
  { accessVersion: 3 },
])("refuses reservation substitution %j", async (change) => {
  mocks.reserve.mockResolvedValue({
    reservationId: "reservation",
    projectId: "canonical-project",
    ...args,
    ...change,
  });
  await expect(setupLocalStudyPreview(args)).rejects.toThrow("does not match");
  expect(mocks.workspace).not.toHaveBeenCalled();
  expect(mocks.ready).not.toHaveBeenCalled();
});

it("preserves the existing local client authorization requirement", async () => {
  mocks.ready.mockRejectedValue(new Error("Set up Codex from Add client"));
  await expect(setupLocalStudyPreview(args)).rejects.toThrow(
    "Set up Codex from Add client",
  );
});

it.each([
  undefined,
  { source: "legacy", modelId: "openai/gpt-5" },
  { modelId: "openai/gpt-5" },
])("requires an explicitly saved model source: %j", async (modelSelection) => {
  mocks.config.mockResolvedValue({
    ok: true,
    config: { ...config, modelSelection },
  });
  await expect(setupLocalStudyPreview(args)).rejects.toThrow(
    "Choose and save a model source",
  );
  expect(mocks.reserve).not.toHaveBeenCalled();
});
