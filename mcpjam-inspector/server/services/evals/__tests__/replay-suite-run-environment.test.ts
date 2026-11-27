import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
const admission = vi.hoisted(() => ({ execution: vi.fn(() => ({ ok: true })), harness: vi.fn(() => ({ ok: true, harness: undefined })), policy: vi.fn(() => null), failed: vi.fn(async () => {}), explain: vi.fn(async ({ admission }: { admission: { reason: string } }) => admission.reason) }));
vi.mock("../explain-harness-refusal.js", () => ({ explainEvalHarnessRefusal: admission.explain }));
vi.mock("../harness-admission.js", async (original) => ({ ...await original<typeof import("../harness-admission.js")>(), checkEvalExecutionAdmission: admission.execution, checkEvalHarnessAdmission: admission.harness, casesAssertingWidgetRender: () => [], failRunBeforeExecution: admission.failed }));
vi.mock("../../../utils/harness/harness-proxy-policy-enforcement.js", () => ({ harnessToolPolicyLaunchRefusal: admission.policy }));
import { ConvexError } from "convex/values";

// Replays use the frozen client and environment; old backends fail closed
// when they cannot identify the environment whose secrets would be delivered.

const runEvalSuiteWithAiSdkMock = vi.fn(async (_options: Record<string, unknown>) => undefined);
vi.mock("../../evals-runner.js", () => ({
  runEvalSuiteWithAiSdk: (...args: unknown[]) =>
    runEvalSuiteWithAiSdkMock(args[0] as Record<string, unknown>),
}));

const startSuiteRunWithRecorderMock = vi.fn(async () => ({
  runId: "replay-run-1",
  recorder: { id: "recorder" },
  config: { tests: [], environment: { servers: ["srv"] } },
  hostConfig: { harness: "harness:cursor" },
  gradingEngine: undefined,
}));
vi.mock("../recorder.js", () => ({
  startSuiteRunWithRecorder: (...args: unknown[]) =>
    startSuiteRunWithRecorderMock(...(args as [])),
}));

vi.mock("../route-helpers.js", () => ({
  buildReplayManager: vi.fn(() => ({
    disconnectAllServers: vi.fn(async () => {}),
  })),
  captureToolSnapshotForEvalAuthoring: vi.fn(async () => ({
    toolSnapshot: {},
    toolSnapshotDebug: {},
  })),
  connectReplayManagerServers: vi.fn(async () => {}),
  fetchReplayConfig: vi.fn(async () => ({
    servers: [{ serverId: "srv", url: "https://example.test" }],
  })),
  requireConvexHttpUrl: vi.fn(() => "https://convex.test"),
  storeReplayConfig: vi.fn(async () => {}),
}));

vi.mock("../compat-runtime.js", () => ({
  loadSuiteHostConfig: vi.fn(async () => ({ harness: "harness:cursor" })),
}));

vi.mock("@mcpjam/sdk/host-config/internal", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mcpjam/sdk/host-config/internal")>(),
  resolveOpenAiCompatForHostConfig: vi.fn(() => false),
}));

vi.mock("../replay-tool-policy.js", () => ({
  recoverToolPolicyFromSourceRun: vi.fn(async () => undefined),
}));

vi.mock("../grading-mode.js", () => ({
  resolveFrozenRunGradingMode: vi.fn(() => undefined),
}));

const resolveOrgModelConfigMock = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/org-model-config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../utils/org-model-config.js")>(),
  resolveOrgModelConfig: resolveOrgModelConfigMock,
}));

import { prepareSuiteReplayFromRun, executeSuiteReplayFromRun } from "../replay-suite-run.js";
import { buildReplayManager, fetchReplayConfig, storeReplayConfig } from "../route-helpers.js";
import { namePin } from "../../../test/support/skill-delivery.js";
import type { RunPinnedSkill } from "../run-plugin-snapshot.js";

/** A source run that WAS environment-backed, replayed by an ordinary caller. */
function convexClient() {
  return {
    query: vi.fn(async () => ({
      suiteId: "suite-1",
      projectId: "project-1",
      hasServerReplayConfig: true,
      environment: { servers: ["srv"] },
    })),
  } as never;
}

beforeEach(() => {
  runEvalSuiteWithAiSdkMock.mockClear();
  resolveOrgModelConfigMock.mockReset().mockResolvedValue({
    aiKeyPolicy: { requireOrgKeys: false }, providers: [],
  });
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
});

afterEach(() => vi.unstubAllEnvs());

it("replays recorded case accounts without reading an archived credential bundle", async () => {
  const plan = [{ testCaseId: "case-1", serverId: "srv", connectionId: "original", source: "default" }];
  const client = { query: vi.fn().mockResolvedValueOnce({
    hasPerCaseAccounts: true, hasServerReplayConfig: true, suiteId: "suite-1", projectId: "project-1",
    environment: { servers: ["srv"], serverBindings: [{ serverName: "srv", projectServerId: "srv" }] },
  }).mockResolvedValueOnce(plan) };
  const manager = { listServers: () => [], disconnectAllServers: vi.fn(async () => {}) };
  const managerForCase = vi.fn().mockReturnValue(manager);
  const close = vi.fn(async () => {});
  const openReplayServers = vi.fn().mockResolvedValue({ manager, managerForCase, close, serverIds: ["srv"], serverBindings: [] });
  vi.mocked(fetchReplayConfig).mockClear();
  const prepared = await prepareSuiteReplayFromRun({ convexClient: client as never, convexAuthToken: "token", sourceRunId: "source-run-1", openReplayServers });
  expect(fetchReplayConfig).not.toHaveBeenCalled();
  expect(openReplayServers).toHaveBeenCalledWith(expect.objectContaining({ plan }));
  expect(startSuiteRunWithRecorderMock).toHaveBeenLastCalledWith(expect.objectContaining({ evalAccountPlan: plan }));
  await prepared.execute();
  expect(runEvalSuiteWithAiSdkMock).toHaveBeenLastCalledWith(expect.objectContaining({ accountManagerForCase: managerForCase }));
  await prepared.cleanup();
  expect(close).toHaveBeenCalledOnce();
});

it.each(["running", "completed"])("adopts a snapshot replay in %s without setup or execution", async (status) => {
  const original = startSuiteRunWithRecorderMock.getMockImplementation()!;
  startSuiteRunWithRecorderMock.mockImplementationOnce(async () => ({ ...await original(), deduped: true, status }));
  admission.execution.mockClear();admission.failed.mockClear();vi.mocked(storeReplayConfig).mockClear();
  const prepared = await prepareSuiteReplayFromRun({ convexClient: convexClient(), convexAuthToken: "token", sourceRunId: "source-run-1" });
  expect(prepared).toMatchObject({ deduped: true, status, runId: "replay-run-1" });
  await expect(prepared.execute()).rejects.toThrow(/already has an executor/);
  await prepared.cleanup();
  expect(admission.execution).not.toHaveBeenCalled();expect(admission.failed).not.toHaveBeenCalled();
  expect(storeReplayConfig).not.toHaveBeenCalled();expect(runEvalSuiteWithAiSdkMock).not.toHaveBeenCalled();
});

it("the synchronous replay returns an adopted run without executing and closes its manager", async () => {
  const original = startSuiteRunWithRecorderMock.getMockImplementation()!;
  startSuiteRunWithRecorderMock.mockImplementationOnce(async () => ({ ...await original(), deduped: true, status: "running" }));
  await expect(executeSuiteReplayFromRun({ convexClient: convexClient(), convexAuthToken: "token", sourceRunId: "source-run-1" })).resolves.toMatchObject({ runId: "replay-run-1", message: "An existing replay run was found. Read its status for the result." });
  expect(runEvalSuiteWithAiSdkMock).not.toHaveBeenCalled();
  const manager = vi.mocked(buildReplayManager).mock.results.at(-1)?.value;
  expect(manager.disconnectAllServers).toHaveBeenCalledTimes(1);
});

it("fails a replay this machine can't run with why, not the cloud's refusal", async () => {
  const refusal = { ok: false, harness: "claude-code", reason: "needs a cloud computer", kind: "computers-unconfigured" };
  const explained = "Couldn't run Claude Code on this machine because it isn't set up for this project. Set it up in the Playground, then run the eval again.";
  admission.harness.mockReturnValueOnce(refusal as never);
  admission.explain.mockResolvedValueOnce(explained);
  admission.failed.mockClear();
  await expect(prepareSuiteReplayFromRun({ convexClient: convexClient(), convexAuthToken: "token", sourceRunId: "source-run-1" }))
    .rejects.toThrow(explained);
  expect(admission.explain).toHaveBeenCalledWith({ admission: refusal, bearer: "token", projectId: "project-1" });
  expect(admission.failed).toHaveBeenCalledWith(expect.anything(), expect.anything(), "replay-run-1", { reason: explained });
  expect(runEvalSuiteWithAiSdkMock).not.toHaveBeenCalled();
});

describe("prepareSuiteReplayFromRun — the environment it cannot name", () => {
  it("hands the runner a REASON instead of silence, and never an invented id", async () => {
    const prepared = await prepareSuiteReplayFromRun({
      convexClient: convexClient(),
      convexAuthToken: "token",
      sourceRunId: "source-run-1",
    });
    await prepared.execute();

    expect(runEvalSuiteWithAiSdkMock).toHaveBeenCalledTimes(1);
    const options = runEvalSuiteWithAiSdkMock.mock.calls[0]![0] as unknown as {
      projectEnvironmentId?: string;
      projectEnvironmentUnresolvedReason?: string;
    };

    // Guessing an id would be the worse failure of the two: it would let the
    // harness check a selection belonging to some OTHER environment and start
    // a turn on the strength of it.
    expect(options.projectEnvironmentId).toBeUndefined();

    // Non-vacuous: a real, non-empty explanation naming replay — this is the
    // whole payload, so an empty or missing string is a broken thread.
    expect(typeof options.projectEnvironmentUnresolvedReason).toBe("string");
    expect(options.projectEnvironmentUnresolvedReason!.length).toBeGreaterThan(
      20,
    );
    expect(options.projectEnvironmentUnresolvedReason).toMatch(/replay/i);
    expect(options.projectEnvironmentUnresolvedReason).toMatch(
      /Project Environment/,
    );
  });
});

it("passes the saved Claude client and frozen environment to the shared executor", async () => {
  startSuiteRunWithRecorderMock.mockResolvedValueOnce({
    runId: "local-replay", recorder: { id: "recorder" },
    config: { tests: [], environment: { servers: ["srv"] } },
    hostConfig: { harness: "claude-code" }, gradingEngine: undefined,
    environmentRef: { environmentId: "frozen-environment" },
  } as any);
  const prepared = await prepareSuiteReplayFromRun({
    convexClient: convexClient(), convexAuthToken: "token", sourceRunId: "source",
  });
  await prepared.execute();
  expect(runEvalSuiteWithAiSdkMock).toHaveBeenCalledWith(expect.objectContaining({
    suiteHostConfig: { harness: "claude-code" },
    projectEnvironmentId: "frozen-environment",
  }));
  expect(runEvalSuiteWithAiSdkMock.mock.calls[0]?.[0]).not.toHaveProperty("projectEnvironmentUnresolvedReason");
});

it.each(["execution", "harness", "policy"] as const)("refuses replay when %s admission fails, before any model runs", async gate => {
  admission.failed.mockClear();
  if (gate === "policy") admission.policy.mockReturnValueOnce("Policy cannot be enforced" as never);
  else admission[gate].mockReturnValueOnce({ ok: false, reason: "Client cannot execute" } as never);
  await expect(prepareSuiteReplayFromRun({ convexClient: convexClient(), convexAuthToken: "token", sourceRunId: "refused-run" })).rejects.toThrow();
  expect(admission.failed).toHaveBeenCalledOnce();
  expect(runEvalSuiteWithAiSdkMock).not.toHaveBeenCalled();
});

describe("a web client's replay", () => {
  function replay(record: () => Promise<unknown>) {
    admission.harness.mockReturnValueOnce({ ok: true, harness: "claude-web" } as never);
    admission.failed.mockClear();
    const mutation = vi.fn(async (_name: string, _args: unknown) => record());
    const client = { ...(convexClient() as unknown as Record<string, unknown>), mutation };
    const prepared = prepareSuiteReplayFromRun({ convexClient: client as never, convexAuthToken: "token", sourceRunId: "source-run-1" });
    return { mutation, prepared };
  }

  it("freezes its web accounts before any turn", async () => {
    const { mutation, prepared } = replay(async () => []);
    await (await prepared).execute();
    expect(mutation).toHaveBeenCalledWith("webClientSuites:recordWebAccountsAtRun", { runId: "replay-run-1", vendor: "claude" });
    expect(runEvalSuiteWithAiSdkMock).toHaveBeenCalledOnce();
  });

  it("stops before any turn when the backend won't freeze them", async () => {
    const { prepared } = replay(async () => {
      throw new ConvexError({ code: "VALIDATION", message: "Web clients are off for this project." });
    });
    await expect(prepared).rejects.toMatchObject({ status: 400, message: "Web clients are off for this project." });
    expect(admission.failed).toHaveBeenCalledWith(expect.anything(), expect.anything(), "replay-run-1", {
      reason: "Web clients are off for this project.",
    });
    expect(runEvalSuiteWithAiSdkMock).not.toHaveBeenCalled();
  });
});

describe("prepareSuiteReplayFromRun — a replay that brings its own keys", () => {
  it("still reads the organization's AI-key policy and hands the runner its config", async () => {
    const strict = {
      aiKeyPolicy: { requireOrgKeys: true },
      providers: [{ providerKey: "openai", exportDenied: true }],
    };
    resolveOrgModelConfigMock.mockResolvedValueOnce(strict);
    const prepared = await prepareSuiteReplayFromRun({
      convexClient: convexClient(),
      convexAuthToken: "token",
      sourceRunId: "keyed-run",
      modelApiKeys: { openai: "sk-personal" },
    });
    await prepared.execute();

    expect(resolveOrgModelConfigMock).toHaveBeenCalledWith(
      { projectId: "project-1" },
      expect.objectContaining({ bearerToken: "token" }),
    );
    // The runner refuses personal and hosted selections under this config.
    expect(runEvalSuiteWithAiSdkMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelApiKeys: { openai: "sk-personal" },
        orgModelConfig: strict,
      }),
    );
  });

  it("refuses before the replay run is created when the policy can't be read", async () => {
    admission.failed.mockClear();
    startSuiteRunWithRecorderMock.mockClear();
    resolveOrgModelConfigMock.mockRejectedValueOnce(
      new Error("The organization's AI key policy could not be read"),
    );
    await expect(
      prepareSuiteReplayFromRun({
        convexClient: convexClient(),
        convexAuthToken: "token",
        sourceRunId: "keyed-run",
        modelApiKeys: { openai: "sk-personal" },
      }),
    ).rejects.toThrow(/policy could not be read/);
    // Nothing was created or reserved, so there is no run to fail.
    expect(startSuiteRunWithRecorderMock).not.toHaveBeenCalled();
    expect(admission.failed).not.toHaveBeenCalled();
    expect(runEvalSuiteWithAiSdkMock).not.toHaveBeenCalled();
  });
});

describe("prepareSuiteReplayFromRun — the source run's skills", () => {
  /** A backend that copied the source run's pins onto the replay run. */
  function clientWithPins(pinnedSkills: RunPinnedSkill[]) {
    const query = vi.fn(async (name: string) =>
      name === "testSuites:getRunPinnedSkills"
        ? { pinnedSkills }
        : {
            suiteId: "suite-1",
            projectId: "project-1",
            hasServerReplayConfig: true,
            environment: { servers: ["srv"] },
          },
    );
    return { client: { query } as never, query };
  }

  it("hands the runner the skills the replay run froze from its source run", async () => {
    const { client, query } = clientWithPins([namePin("deploy")]);
    const prepared = await prepareSuiteReplayFromRun({
      convexClient: client,
      convexAuthToken: "token",
      sourceRunId: "source-run-1",
    });
    await prepared.execute();

    expect(query).toHaveBeenCalledWith("testSuites:getRunPinnedSkills", {
      runId: "replay-run-1",
    });
    const options = runEvalSuiteWithAiSdkMock.mock.calls[0]![0] as any;
    expect(
      options.pinnedSkillSource.pins.map((pin: RunPinnedSkill) => pin.name),
    ).toEqual(["deploy"]);
    expect(
      options.pinnedSkillSource.harnessSkills.map(
        (skill: { name: string }) => skill.name,
      ),
    ).toEqual(["deploy"]);
  });

  it("hands a replay of a run without skills an empty set, never the project's", async () => {
    const prepared = await prepareSuiteReplayFromRun({
      convexClient: convexClient(),
      convexAuthToken: "token",
      sourceRunId: "source-run-1",
    });
    await prepared.execute();

    const options = runEvalSuiteWithAiSdkMock.mock.calls[0]![0] as any;
    expect(options.pinnedSkillSource.pins).toEqual([]);
    expect(options.pinnedSkillSource.harnessSkills).toEqual([]);
  });

  it("stops before any model call when a frozen skill's file can't be read", async () => {
    admission.failed.mockClear();
    const { client } = clientWithPins([
      namePin("deploy", {
        files: [{ path: "scripts/run.sh", contentHash: "f", size: 1, url: null }],
      }),
    ]);

    await expect(
      prepareSuiteReplayFromRun({
        convexClient: client,
        convexAuthToken: "token",
        sourceRunId: "source-run-1",
      }),
    ).rejects.toThrow(/scripts\/run\.sh/);
    expect(admission.failed).toHaveBeenCalledWith(
      client,
      expect.anything(),
      "replay-run-1",
      { reason: expect.stringMatching(/"deploy"/) },
    );
    expect(runEvalSuiteWithAiSdkMock).not.toHaveBeenCalled();
  });
});
