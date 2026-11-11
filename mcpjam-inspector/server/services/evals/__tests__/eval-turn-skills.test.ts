/**
 * An eval run's frozen skills, from the runner to the engine and the turn
 * record.
 *
 * A harness run with a skill is here on purpose: a change at this seam once
 * handed a harness iteration its run's pins as agent tools as well, and every
 * harness run that had a skill failed before its first model call while runs
 * without skills stayed green. Only the engine and the local run's preparation
 * are mocked; the runner, `prepareChatV2` and the trace persist are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSelection } from "@mcpjam/sdk";

const localVenue = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock(
  "../../../utils/harness/local/run-resources",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../utils/harness/local/run-resources")
    >()),
    prepareLocalHarnessRun: localVenue.prepare,
  }),
);

vi.mock("../../../utils/mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

const assistantTurn = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/assistant-turn.js", () => ({
  runAssistantTurn: (...args: unknown[]) => assistantTurn(...args),
}));

import { runEvalSuiteWithAiSdk } from "../../evals-runner";
import { preparedRunSkills } from "../../../test/support/skill-delivery";

const MODEL = "anthropic/claude-sonnet-4.5";
const ORG_ANTHROPIC: ModelSelection = {
  modelId: MODEL,
  source: "org",
  connectionRef: { kind: "orgProvider", id: "orgprov_anthropic_1" },
  nativeModelId: "claude-sonnet-4-5",
  fallback: { provider: "none", model: "none" },
};

function manager() {
  return {
    getToolsForAiSdk: vi.fn(async () => ({})),
    listTools: vi.fn(async () => ({ tools: [] })),
    getAllToolAnnotations: vi.fn(() => ({})),
    hasCachedToolAnnotations: vi.fn(() => true),
    getConnectionStatus: vi.fn(() => "connected"),
    listServers: vi.fn(() => ["srv-1"]),
    getAllToolsMetadata: vi.fn(() => ({})),
    hasServer: vi.fn(() => true),
    getSkillsSupport: vi.fn(() => ({ active: false })),
    executeTool: vi.fn(),
  };
}

/** A Convex client that keeps the `turn` of each per-turn trace write. */
function recordingClient() {
  const turns: Record<string, unknown>[] = [];
  const client = {
    query: vi.fn(async () => ({ status: "running" })),
    mutation: vi.fn(async () => ({ iterationId: "iter-1" })),
    action: vi.fn(
      async (name: string, args?: { turn?: Record<string, unknown> }) => {
        if (name === "testSuites:appendEvalTurnTrace" && args?.turn) {
          turns.push(args.turn);
        }
        return name === "testSuites:startQuickRunIteration"
          ? { iterationId: "iter-1" }
          : undefined;
      },
    ),
  };
  return { client, turns };
}

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
  localVenue.prepare.mockReset();
  localVenue.prepare.mockResolvedValue({
    target: {
      machineId: "machine-1",
      runtimeId: "runtime-1",
      targetId: "target-1",
      localSessionId: "local-run-1",
    },
    cleanup: vi.fn(async () => {}),
  });
  assistantTurn.mockReset();
  assistantTurn.mockImplementation(async (opts: { messages: unknown[] }) => ({
    messages: [...opts.messages, { role: "assistant", content: "Done." }],
    turnTrace: { spans: [] },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function runWithSkills(suiteHostConfig: Record<string, unknown>) {
  const run = await preparedRunSkills();
  const { client, turns } = recordingClient();
  await runEvalSuiteWithAiSdk({
    suiteId: "suite-1",
    runId: null,
    config: {
      tests: [
        {
          title: "Case",
          query: "Write the notes",
          model: MODEL,
          provider: "anthropic",
          selection: ORG_ANTHROPIC,
          runs: 1,
          testCaseId: "case-1",
          expectedToolCalls: [],
          promptTurns: [
            { id: "turn-1", prompt: "Write the notes", expectedToolCalls: [] },
          ],
        },
      ],
      environment: { servers: ["srv-1"] },
    },
    modelApiKeys: {},
    convexClient: client,
    convexHttpUrl: "https://example.convex.site",
    convexAuthToken: "token",
    mcpClientManager: manager(),
    testCaseId: "case-1",
    orgModelConfigTarget: { projectId: "project-1" },
    harnessRuntimeVenue: "local",
    suiteHostConfig,
    pinnedSkillSource: run.pinnedSkillSource,
    pinnedHarnessSkills: run.pinnedHarnessSkills,
  } as Parameters<typeof runEvalSuiteWithAiSdk>[0]);
  return { run, turns };
}

describe("an eval run with frozen skills", () => {
  it("runs a harness iteration with its skills on the box and no skill tools", async () => {
    const { run, turns } = await runWithSkills({ harness: "claude-code" });

    expect(assistantTurn).toHaveBeenCalledTimes(1);
    const options = assistantTurn.mock.calls[0]![0] as {
      harness?: string;
      pinnedHarnessSkills?: unknown;
      tools?: Record<string, unknown>;
    };
    expect(options.harness).toBe("claude-code");
    expect(options.pinnedHarnessSkills).toBe(run.pinnedHarnessSkills);
    expect(Object.keys(options.tools ?? {})).not.toContain("loadSkill");
    expect(
      (turns[0]!.skillsAtTurn as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    ).toEqual(["release-notes", "summarize", "search"]);
  });

  it("hands MCPJam's agent the run's skills as tools and records them", async () => {
    const { turns } = await runWithSkills({});

    expect(assistantTurn).toHaveBeenCalledTimes(1);
    const options = assistantTurn.mock.calls[0]![0] as {
      tools?: Record<string, unknown>;
    };
    expect(Object.keys(options.tools ?? {})).toEqual(
      expect.arrayContaining(["loadSkill", "listSkillFiles", "readSkillFile"]),
    );
    expect(
      (turns[0]!.skillsAtTurn as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    ).toEqual(["release-notes", "summarize", "search"]);
  });
});
