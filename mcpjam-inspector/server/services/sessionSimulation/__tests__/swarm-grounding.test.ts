import { describe, expect, it, vi } from "vitest";
vi.mock("../runner", () => ({ drainAssistantTurn: vi.fn() }));
vi.mock("../../../utils/chat-v2-orchestration", () => ({
  prepareChatV2: vi.fn(),
}));
import { computeSetupExcludedToolNames } from "../swarm-setup-policy";
import {
  deriveCreatedEntities,
  judgeReadiness,
  parseSetupReport,
} from "../swarm-setup-evidence";
import { drainAssistantTurn } from "../runner";
import { prepareChatV2 } from "../../../utils/chat-v2-orchestration";
import {
  createSetupToolGate,
  runSwarmSetupTurn,
  SwarmSetupError,
} from "../swarm-setup-turn";
import {
  isZeroArgSchema,
  probeReadOnlyTools,
  selectDiscoveryTools,
} from "../target-discovery";
import type { SetupRecord } from "../../../../shared/swarm-grounding";
import type { MCPClientManager } from "@mcpjam/sdk";
const tool = (name: string, annotations?: Record<string, unknown>) => ({
  serverId: "s",
  name,
  annotations,
  inputSchema: { type: "object" },
});
const write = { readOnlyHint: false, destructiveHint: false };
function setup(): SetupRecord {
  return {
    status: "completed",
    readiness: "unavailable",
    prefix: "swarm-test-",
    createdEntities: [],
    observedCreatedEntityCount: 0,
    unsupportedClaims: 0,
    missing: [],
    toolCalls: [],
    writeCallsDispatched: 0,
    retried: false,
    admittedWriteTools: ["create_project"],
    excludedToolCount: 0,
    startedAt: 0,
    durationMs: 0,
    chatSessionId: "setup",
  };
}
const result = (name: string, id: string) => ({
  structuredContent: { name, id },
});
describe("setup catalog policy", () => {
  it("admits reads and creation-like writes, never upserts or paid executions", () => {
    const policy = computeSetupExcludedToolNames([
      tool("list_projects", { readOnlyHint: true }),
      tool("create_project", write),
      ...[
        "upsert_record",
        "run_eval_suite",
        "send_chat_message",
        "create_secret",
      ].map((name) => tool(name, write)),
      tool("create_unknown"),
      tool("create_bad", { readOnlyHint: true, destructiveHint: true }),
      tool("call_server_tool"),
    ]);
    expect(policy.admittedWriteTools).toEqual(["create_project"]);
    expect(policy.admittedReadTools).toEqual(["list_projects"]);
    expect(policy.excluded).toHaveLength(7);
  });
  it("denies flattened name collisions", () =>
    expect(
      computeSetupExcludedToolNames([
        tool("create_project", write),
        { ...tool("create_project", write), serverId: "other" },
      ]).admittedWriteTools,
    ).toEqual([]));
});
describe("setup evidence and readiness", () => {
  it("retains creations omitted by the model and rejects mismatched IDs", () => {
    const s = setup();
    s.toolCalls = [0, 1].map(() => ({
      serverId: "s",
      toolName: "create_project",
      ok: true,
      isWrite: true,
      dispatched: true,
    }));
    s.writeCallsDispatched = 2;
    const report = parseSetupReport(
      '{"ready":true,"created":[{"name":"swarm-test-A","id":"a"}],"missing":[]}',
    );
    const evidence = deriveCreatedEntities({
      setup: s,
      modelReport: report,
      toolResults: new Map([
        [0, result("swarm-test-A", "a")],
        [1, result("B", "b")],
      ]),
    });
    expect(evidence.createdEntities.map((e) => e.id)).toEqual(["a", "b"]);
    expect(evidence.createdEntities[1].unprefixed).toBe(true);
    Object.assign(s, evidence);
    expect(judgeReadiness(s, report).readiness).toBe("ready");
    const bad = parseSetupReport(
      '{"ready":true,"created":[{"name":"swarm-test-A","id":"invented"}],"missing":[]}',
    );
    expect(
      deriveCreatedEntities({
        setup: s,
        modelReport: bad,
        toolResults: new Map([[0, result("swarm-test-A", "a")]]),
      }).unsupportedClaims,
    ).toBe(1);
  });
  it("fails malformed JSON even with zero writes; skipped means not assessed", () => {
    expect(judgeReadiness(setup(), parseSetupReport("nope")).readiness).toBe(
      "unavailable",
    );
    expect(
      judgeReadiness(
        setup(),
        parseSetupReport('{"ready":true,"created":[],"missing":[]}'),
      ).readiness,
    ).toBe("not_needed");
    expect(
      judgeReadiness(
        { ...setup(), status: "skipped", reason: "no_eligible_write_tools" },
        undefined,
      ).readiness,
    ).toBe("not_assessed");
    expect(
      judgeReadiness(
        setup(),
        parseSetupReport('{"ready":false,"created":[],"missing":[]}'),
      ).readiness,
    ).toBe("unavailable");
  });
  it("does not count errors or echoed arguments as creations", () => {
    const s = setup();
    s.toolCalls = [
      {
        serverId: "s",
        toolName: "create_project",
        ok: true,
        isWrite: true,
        dispatched: true,
      },
    ];
    for (const output of [
      { isError: true, ...result("QA", "x") },
      { arguments: { name: "QA", id: "x" } },
    ])
      expect(
        deriveCreatedEntities({
          setup: s,
          modelReport: undefined,
          toolResults: new Map([[0, output]]),
        }).createdEntities,
      ).toEqual([]);
  });
});
describe("setup execution budget", () => {
  it("reserves eight calls synchronously, refuses the ninth in the same step", async () => {
    const s = setup();
    const execute = vi.fn(async () => result("QA", "x"));
    const gate = createSetupToolGate({
      tools: { create_project: { inputSchema: {} as never, execute } },
      catalog: [tool("create_project", write)],
      setup: s,
      results: new Map(),
      signal: new AbortController().signal,
    });
    await Promise.all(
      Array.from({ length: 9 }, () =>
        gate.create_project.execute!({}, { toolCallId: "c", messages: [] }),
      ),
    );
    expect(execute).toHaveBeenCalledTimes(8);
    expect(s.writeCallsDispatched).toBe(8);
    expect(s.toolCalls[8]).toMatchObject({ ok: false, dispatched: false });
  });
  it("records dispatch before a transport exception", async () => {
    const s = setup();
    const gate = createSetupToolGate({
      tools: {
        create_project: {
          inputSchema: {} as never,
          execute: async () => {
            throw new Error("lost response");
          },
        },
      },
      catalog: [tool("create_project", write)],
      setup: s,
      results: new Map(),
      signal: new AbortController().signal,
    });
    await expect(
      gate.create_project.execute!({}, { toolCallId: "c", messages: [] }),
    ).rejects.toThrow();
    expect(s.writeCallsDispatched).toBe(1);
  });
});
describe("read-only discovery", () => {
  it("requires read-only annotations and zero required arguments", () => {
    expect(isZeroArgSchema({ type: "object", required: ["id"] })).toBe(false);
    expect(isZeroArgSchema({ type: "object", allOf: [{}] })).toBe(false);
    expect(
      selectDiscoveryTools([
        tool("create_project", write),
        tool("list_unknown"),
        tool("list_projects", { readOnlyHint: true }),
      ]).map((t) => t.name),
    ).toEqual(["list_projects"]);
  });
  it("bounds output and drops tool errors", async () => {
    const manager = {
      listTools: vi.fn(async () => ({
        tools: [
          tool("list_a", { readOnlyHint: true }),
          tool("list_b", { readOnlyHint: true }),
        ],
      })),
      executeTool: vi
        .fn()
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "x".repeat(20000) }],
        })
        .mockResolvedValueOnce({
          isError: true,
          content: [{ type: "text", text: "bad" }],
        }),
    };
    const out = await probeReadOnlyTools({
      manager: manager as unknown as MCPClientManager,
      serverIds: ["s"],
    });
    expect(out.probes).toHaveLength(1);
    expect(new TextEncoder().encode(out.probes[0].text).length).toBe(16384);
    expect(out.probedTools).toHaveLength(2);
  });
  it("aborts a parked read", async () => {
    const controller = new AbortController();
    const manager = { listTools: vi.fn(() => new Promise(() => {})) };
    const pending = probeReadOnlyTools({
      manager: manager as unknown as MCPClientManager,
      serverIds: ["s"],
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("setup turn integration", () => {
  it("uses the shared billed turn without a session writer, retains partial creations, and disposes", async () => {
    const dispose = vi.fn(async () => {});
    const manager = {
      listTools: vi.fn(async () => ({
        tools: [tool("create_project", write)],
      })),
    };
    vi.mocked(prepareChatV2).mockResolvedValue({
      allTools: {
        create_project: {
          inputSchema: {},
          execute: async () => result("Created", "real-id"),
        },
        call_server_tool: { inputSchema: {}, execute: vi.fn() },
      },
      enhancedSystemPrompt: "setup",
      resolvedTemperature: 0,
    } as never);
    vi.mocked(drainAssistantTurn).mockImplementation(async (args) => {
      expect(args).toMatchObject({
        sourceType: "swarm",
        journeyRunId: "r",
        hostId: "h",
        projectId: "p",
        authHeader: "Bearer test",
        maxSteps: 6,
        chatSessionId: "swarm-setup:r:t",
      });
      expect(Object.keys(args.tools!)).toEqual(["create_project"]);
      await args.tools!.create_project.execute!(
        {},
        { toolCallId: "c", messages: [] },
      );
      throw new Error("connection lost after write");
    });
    const error = await runSwarmSetupTurn({
      runId: "r",
      projectId: "p",
      target: { hostId: "h", targetId: "t" } as never,
      persona: { name: "Tester" } as never,
      modelDefinition: { id: "model" } as never,
      authHeader: "Bearer test",
      managerFactory: async () => ({
        manager: manager as never,
        connectedServerIds: ["s"],
        dispose,
      }),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(SwarmSetupError);
    expect(error.partial).toMatchObject({
      readiness: "unavailable",
      writeCallsDispatched: 1,
      createdEntities: [{ id: "real-id", name: "Created" }],
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(prepareChatV2).toHaveBeenCalledWith(
      expect.objectContaining({
        skillsSource: { kind: "none" },
        progressiveToolDiscovery: { enabled: false },
        requireToolApproval: false,
      }),
    );
  });
  it("does not label a sibling parent reference as a newly created entity", () => {
    const s = setup();
    s.toolCalls = [
      {
        serverId: "s",
        toolName: "create_project",
        ok: true,
        isWrite: true,
        dispatched: true,
      },
    ];
    const derive = (output: unknown) =>
      deriveCreatedEntities({
        setup: s,
        modelReport: undefined,
        toolResults: new Map([[0, { structuredContent: output }]]),
      });
    expect(
      derive({ project: { id: "parent" }, suite: { id: "child" } })
        .createdEntities,
    ).toEqual([]);
    expect(
      derive({
        project: { id: "parent" },
        created: { id: "child" },
      }).createdEntities.map((e) => e.id),
    ).toEqual(["child"]);
  });
});
