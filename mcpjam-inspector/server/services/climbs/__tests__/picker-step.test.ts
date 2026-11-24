/**
 * One picker step with a stubbed model: the round it submits, the turn that
 * submits nothing, the step cap, the transcript stored and linked, the spend
 * reported, a lease that is lost, and a step resumed after a cut-off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLIMB, fakeConvex } from "./helpers.js";
import { climbRow } from "./climb-fixtures.js";

const hoisted = vi.hoisted(() => ({ convex: null as unknown, marks: [] as unknown[], client: { submitClimbRound: vi.fn() } }));
vi.mock("../../../routes/v1/convex-client.js", () => ({ createConvexClient: () => hoisted.convex }));
vi.mock("../picker-client.js", () => ({
  buildPickerPlatformClient: (_bearer: unknown, mark: unknown, roundKey?: string) => {
    hoisted.marks.push(roundKey ? { ...(mark as object), roundKey } : mark);
    return hoisted.client;
  },
}));

import { PICKER_MAX_STEPS, runPickerStep, submittedRoundOf, type StepClaim, type StepLease } from "../picker-step.js";
import type { PickerPorts } from "../picker-ports.js";
import { PICKER_TOOL_IDS } from "../picker-tools.js";

const claim = (over: Partial<StepClaim> = {}): StepClaim => ({
  climbId: CLIMB,
  generation: 3,
  projectId: "proj1",
  pickerModel: "anthropic/claude-haiku-4.5",
  heartbeatIntervalMs: 5,
  resumeRound: null,
  ...over,
});

const submitted = (roundNumber: number) => ({ toolCallId: "t1", toolName: "submit_climb_round", output: { type: "json", value: { climbId: CLIMB, roundNumber } } });
const turnOf = (over: Record<string, unknown> = {}) => ({
  messages: [{ role: "user", content: "go" }, { role: "assistant", content: "done" }],
  newMessages: [{ role: "assistant", content: "done" }],
  toolCalls: [],
  toolResults: [] as Array<{ toolCallId: string; toolName?: string; output: unknown }>,
  usage: { inputTokens: 1000, outputTokens: 200 },
  turnTrace: { startedAt: 1, endedAt: 2, spans: [{ category: "llm", cost: { amountUsd: 0.02 } }], modelId: "m" },
  aborted: false,
  ...over,
});

function rig(options: { turn?: () => unknown | Promise<unknown>; persist?: (n: number) => unknown } = {}) {
  const { convex, called } = fakeConvex({
    "climbs:getClimb": () => climbRow({ picker: "mcpjam", stepRunner: "hosted", limits: { roundLimit: 5, roundsStarted: 1, roundsLeft: 4, creditLimit: 500, creditsCommitted: 0, creditsLeft: 500 } }),
  });
  hoisted.convex = convex;
  const persisted: Array<Record<string, any>> = [];
  const runTurn = vi.fn(async (_options: Record<string, any>) => (await (options.turn?.() ?? turnOf())) as never);
  const prepareChat = vi.fn(async (opts: Record<string, any>) => ({ allTools: { ...opts.builtInTools }, enhancedSystemPrompt: `${opts.systemPrompt}\n(prepared)` }));
  const ports: PickerPorts = {
    connect: vi.fn(async () => ({ manager: {} as never, writeTools: ["delete_everything"], close: vi.fn(async () => {}) })),
    resolveModel: vi.fn(async ({ modelId }) => ({ id: modelId }) as never),
    resolveRuntime: vi.fn(async () => ({ runtime: { kind: "hosted", endpointPath: "/stream" } as never, modelSource: "mcpjam" as const })),
    prepareChat,
    runTurn: runTurn as never,
    persist: vi.fn(async (opts) => {
      persisted.push(opts as never);
      return (options.persist?.(persisted.length) ?? { outcome: "saved", version: persisted.length, sessionDocId: "chatDoc1" }) as never;
    }),
  };
  const lease = { renew: vi.fn(async () => ({ leaseOk: true, stop: false })), spend: vi.fn(async () => {}) } satisfies StepLease;
  return { ports, lease, runTurn, prepareChat, persisted, called };
}

const bearer = async () => "bearer";

beforeEach(() => {
  hoisted.marks = [];
  hoisted.client.submitClimbRound.mockReset();
});

describe("a step that submits a round", () => {
  it("answers the round the turn submitted, as the one thing to report", async () => {
    const { ports, lease } = rig({ turn: () => turnOf({ toolResults: [submitted(2)] }) });
    expect(await runPickerStep(claim(), lease, bearer, { ports })).toEqual({ kind: "done", submittedRound: 2 });
  });

  it("gives the turn the real server's read-only tools and the climb's operations, with the step cap", async () => {
    const { ports, lease, runTurn, prepareChat } = rig({ turn: () => turnOf({ toolResults: [submitted(2)] }) });
    await runPickerStep(claim(), lease, bearer, { ports });
    expect(prepareChat.mock.calls[0]![0]).toMatchObject({
      selectedServers: ["s_real"],
      requireToolApproval: false,
      excludeMcpToolNames: ["delete_everything"],
    });
    expect(Object.keys(prepareChat.mock.calls[0]![0].builtInTools)).toEqual([...PICKER_TOOL_IDS]);
    expect(PICKER_MAX_STEPS).toBe(30);
    expect(runTurn.mock.calls[0]![0]).toMatchObject({ maxSteps: 30, streamSink: "none", sourceType: "direct", origin: "mcpjam_agent", approvalMode: "auto-deny" });
    expect(runTurn.mock.calls[0]![0].systemPrompt).toContain("What never to read");
  });

  it("runs the turn on the model chosen at start, as the person who started the climb", async () => {
    const { ports, lease, runTurn } = rig({ turn: () => turnOf({ toolResults: [submitted(2)] }) });
    await runPickerStep(claim({ pickerModel: "openai/gpt-5-mini" }), lease, bearer, { ports });
    expect(ports.resolveModel).toHaveBeenCalledWith({ modelId: "openai/gpt-5-mini", projectId: "proj1", bearer: "bearer" });
    expect(runTurn.mock.calls[0]![0].authContext).toEqual({ kind: "user_bearer", token: "Bearer bearer" });
  });

  it("stores the transcript before the round and again when the turn ends, and links it from the round's marker", async () => {
    const { ports, lease, persisted } = rig({ turn: () => turnOf({ toolResults: [submitted(2)] }) });
    await runPickerStep(claim(), lease, bearer, { ports });
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({ chatSessionId: `climb-step-${CLIMB}-3`, sourceType: "direct", origin: "mcpjam_agent", directVisibility: "project" });
    expect(persisted[0]!.sessionMessages).toHaveLength(1);
    expect(persisted[1]).toMatchObject({ chatSessionId: `climb-step-${CLIMB}-3`, expectedVersion: 1 });
    expect(persisted[1]!.sessionMessages).toHaveLength(2);
    // The round the turn submits names the held lease and the stored session.
    expect(hoisted.marks).toEqual([{ climbId: CLIMB, generation: 3, chatSessionId: "chatDoc1", roundKey: `climb-step:${CLIMB}:3` }]);
  });

  it("still submits when the transcript could not be stored first, and the round simply has no link", async () => {
    const { ports, lease } = rig({
      turn: () => turnOf({ toolResults: [submitted(2)] }),
      persist: () => ({ outcome: "failed", failureKind: "timeout" }),
    });
    expect(await runPickerStep(claim(), lease, bearer, { ports })).toEqual({ kind: "done", submittedRound: 2 });
    expect(hoisted.marks).toEqual([{ climbId: CLIMB, generation: 3, roundKey: `climb-step:${CLIMB}:3` }]);
  });

  it("reports what the turn cost, from the prices on its own calls", async () => {
    const { ports, lease } = rig({ turn: () => turnOf({ toolResults: [submitted(2)] }) });
    await runPickerStep(claim(), lease, bearer, { ports });
    expect(lease.spend).toHaveBeenCalledWith({ estimatedCostUsd: 0.02, tokens: 1200 });
  });

  it("does not lose the round when the spend cannot be reported", async () => {
    const { ports, lease } = rig({ turn: () => turnOf({ toolResults: [submitted(2)] }) });
    lease.spend.mockRejectedValueOnce(new Error("down"));
    expect(await runPickerStep(claim(), lease, bearer, { ports })).toEqual({ kind: "done", submittedRound: 2 });
  });

  it("finds a round whose answer the turn did not keep, from the climb's count", async () => {
    const { ports, lease, called } = rig({ turn: () => turnOf({ toolResults: [{ toolCallId: "t1", toolName: "submit_climb_round", output: { type: "json", value: { truncated: true } } }] }) });
    const seen: number[] = [];
    // The second read of the climb says a round was started.
    const original = (hoisted.convex as { query: (...args: unknown[]) => unknown }).query;
    (hoisted.convex as { query: unknown }).query = vi.fn(async (...args: unknown[]) => {
      const climb = (await (original as (...a: unknown[]) => Promise<any>)(...args)) as any;
      seen.push(climb.limits.roundsStarted);
      return seen.length > 1 ? { ...climb, limits: { ...climb.limits, roundsStarted: 2 } } : climb;
    });
    expect(await runPickerStep(claim(), lease, bearer, { ports })).toEqual({ kind: "done", submittedRound: 2 });
    expect(called("climbs:getClimb").length).toBeGreaterThanOrEqual(1);
  });
});

describe("a step that submits nothing", () => {
  it("answers no round, so the runner reports an empty turn and the backend retries it once", async () => {
    const { ports, lease } = rig();
    expect(await runPickerStep(claim(), lease, bearer, { ports })).toEqual({ kind: "done" });
    // The finished turn is still stored, and still costs.
    expect(lease.spend).toHaveBeenCalled();
  });

  it("does not take a refused submit for a round", () => {
    expect(submittedRoundOf({ toolResults: [{ toolCallId: "t", toolName: "submit_climb_round", output: { type: "json", value: { error: "The climb has used its rounds." } } }] })).toBeUndefined();
  });

  it("takes the last submit when a turn tried twice", () => {
    expect(submittedRoundOf({ toolResults: [{ toolCallId: "a", toolName: "submit_climb_round", output: { roundNumber: 1 } }, { toolCallId: "b", toolName: "submit_climb_round", output: { roundNumber: 2 } }] })).toBe(2);
  });
});

describe("a lease that goes", () => {
  const waitsForAbort = (options: Record<string, any>) =>
    new Promise((resolve) => options.abortSignal.addEventListener("abort", () => resolve(turnOf({ aborted: true, toolResults: [submitted(9)] })), { once: true }));

  it("ends the turn when the heartbeat says the lease is lost, and reports nothing", async () => {
    const { ports, lease, runTurn } = rig();
    runTurn.mockImplementation((options: Record<string, any>) => waitsForAbort(options) as never);
    lease.renew.mockResolvedValue({ leaseOk: false, stop: false });
    expect(await runPickerStep(claim(), lease, bearer, { ports })).toEqual({ kind: "lost" });
    expect(lease.spend).not.toHaveBeenCalled();
  });

  it("ends the turn when the climb was stopped under it", async () => {
    const { ports, lease, runTurn } = rig();
    runTurn.mockImplementation((options: Record<string, any>) => waitsForAbort(options) as never);
    lease.renew.mockResolvedValue({ leaseOk: true, stop: true });
    expect(await runPickerStep(claim(), lease, bearer, { ports })).toEqual({ kind: "stopped" });
  });

  it("keeps going when the heartbeat cannot reach the backend: the lease lapses by itself if it stays away", async () => {
    const { ports, lease } = rig({ turn: () => turnOf({ toolResults: [submitted(2)] }) });
    lease.renew.mockRejectedValue(new Error("offline"));
    expect(await runPickerStep(claim(), lease, bearer, { ports })).toEqual({ kind: "done", submittedRound: 2 });
  });

  it("ends the turn when the runner's own signal aborts", async () => {
    const { ports, lease, runTurn } = rig();
    runTurn.mockImplementation((options: Record<string, any>) => waitsForAbort(options) as never);
    const stop = new AbortController();
    const step = runPickerStep(claim(), lease, bearer, { ports, signal: stop.signal });
    setTimeout(() => stop.abort(), 10);
    expect(await step).toEqual({ kind: "done" });
  });
});

describe("a step resumed after a cut-off", () => {
  it("submits the registered round's key again, runs no turn, and answers its number", async () => {
    const { ports, lease, runTurn } = rig();
    hoisted.client.submitClimbRound.mockResolvedValue({ roundNumber: 2, replayed: true });
    const resume = { roundNumber: 2, unitKey: "round:2", idempotencyKey: "climb:c:round:2", serverId: "s_cand", serverVersion: "3" };
    expect(await runPickerStep(claim({ resumeRound: resume }), lease, bearer, { ports })).toEqual({ kind: "done", submittedRound: 2 });
    expect(hoisted.client.submitClimbRound).toHaveBeenCalledWith({ projectId: "proj1", climbId: CLIMB, serverId: "s_cand", serverVersion: "3", idempotencyKey: "climb:c:round:2" });
    expect(runTurn).not.toHaveBeenCalled();
    expect(hoisted.marks).toEqual([{ climbId: CLIMB, generation: 3 }]);
  });
});

describe("a step on a climb MCPJam does not pick for", () => {
  it("refuses to run, before it touches the model", async () => {
    const { ports, lease } = rig();
    hoisted.convex = fakeConvex({ "climbs:getClimb": () => climbRow({ picker: "agent" }) }).convex;
    await expect(runPickerStep(claim(), lease, bearer, { ports })).rejects.toThrow(/not picked by MCPJam/);
    expect(ports.resolveModel).not.toHaveBeenCalled();
  });
});
