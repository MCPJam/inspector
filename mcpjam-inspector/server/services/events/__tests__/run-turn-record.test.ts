/**
 * What a hosted event run's turn records (`eventRunTurnRecord`), and that the
 * executor writes it onto the turn trace it appends to the trigger's thread.
 */

import { describe, expect, it, vi } from "vitest";
import type { EventRunClaim, EventRunInput } from "../backend-client.js";
import { executeClaimedEventRun, type EventExecutorDeps } from "../executor.js";
import type { TranscriptPort } from "../run-transcript.js";
import { eventRunTurnRecord } from "../run-turn-record.js";

function input(
  event: Partial<EventRunInput["event"]> = {},
  subscription: Partial<EventRunInput["subscription"]> = {},
): EventRunInput {
  return {
    trigger: {
      id: "trg_1",
      revision: 1,
      instructions: "Reply to every new comment.",
      approvalPolicy: "auto_deny",
      maxSteps: 2,
      environmentId: null,
    },
    event: {
      eventId: "evt_1",
      name: "comment.created",
      timestamp: "2026-09-30T00:00:00Z",
      data: { text: "hello" },
      origin: "webhook",
      receivedAt: 1_700_000_000_000,
      ...event,
    },
    subscription: {
      id: "sub_doc_1",
      logicalId: "esub_1",
      generation: 1,
      bindingKey: "b".repeat(64),
      serverId: "srv_events",
      environmentId: null,
      ...subscription,
    },
  };
}

describe("eventRunTurnRecord", () => {
  it("names a webhook event as the server's, with its subscription and trigger", () => {
    expect(
      eventRunTurnRecord({ input: input(), triggerId: "trg_1" }),
    ).toEqual({
      eventAtTurn: {
        name: "comment.created",
        eventId: "evt_1",
        timestamp: "2026-09-30T00:00:00Z",
        receivedAt: 1_700_000_000_000,
        delivery: "webhook",
        origin: "server",
        subscriptionId: "esub_1",
        triggerId: "trg_1",
      },
      skillsAtTurn: [],
    });
  });

  it.each(["poll", "push"] as const)("reads a %s origin as its delivery mode", (mode) => {
    const record = eventRunTurnRecord({
      input: input({ origin: mode }, { mode: "webhook" }),
      triggerId: "trg_1",
    });
    expect(record.eventAtTurn).toMatchObject({ origin: "server", delivery: mode });
  });

  it.each(["simulation", "replay"] as const)(
    "keeps a %s origin and takes the subscription's mode from the snapshot",
    (origin) => {
      const record = eventRunTurnRecord({
        input: input({ origin }, { mode: "poll" }),
        triggerId: "trg_1",
      });
      expect(record.eventAtTurn).toMatchObject({ origin, delivery: "poll" });
    },
  );

  it("leaves a test event without a delivery mode when the snapshot predates it", () => {
    const record = eventRunTurnRecord({
      input: input({ origin: "simulation" }),
      triggerId: "trg_1",
    });
    expect(record.eventAtTurn?.origin).toBe("simulation");
    expect(record.eventAtTurn).not.toHaveProperty("delivery");
  });

  it("reads an unknown or missing snapshot origin as the server's, with no delivery mode", () => {
    for (const origin of ["sse", undefined]) {
      const record = eventRunTurnRecord({
        input: input({ origin }, { mode: "push" }),
        triggerId: "trg_1",
      });
      expect(record.eventAtTurn?.origin).toBe("server");
      expect(record.eventAtTurn).not.toHaveProperty("delivery");
    }
  });

  it("falls back to the subscription's document id without a logical one", () => {
    const record = eventRunTurnRecord({
      input: input({}, { logicalId: undefined }),
      triggerId: "trg_1",
    });
    expect(record.eventAtTurn?.subscriptionId).toBe("sub_doc_1");
  });

  it("clips a name at the limit without splitting an astral character", () => {
    const record = eventRunTurnRecord({
      input: input({ name: `${"a".repeat(511)}\u{1F600}` }),
      triggerId: "trg_1",
    });
    expect(record.eventAtTurn?.name).toBe("a".repeat(511));
  });

  it("records no event without a receive time, and never the event's data", () => {
    const record = eventRunTurnRecord({
      input: input({ receivedAt: undefined }),
      triggerId: "trg_1",
    });
    expect(record).toEqual({ skillsAtTurn: [] });
    const withData = eventRunTurnRecord({ input: input(), triggerId: "trg_1" });
    expect(JSON.stringify(withData)).not.toContain("hello");
  });

  it("records a named environment, and none with an empty name", () => {
    expect(
      eventRunTurnRecord({
        input: input(),
        triggerId: "trg_1",
        environmentRef: { environmentId: "env_1", name: "Staging", revision: 3 },
      }).environmentAtTurn,
    ).toEqual({ environmentId: "env_1", name: "Staging", revision: 3 });
    expect(
      eventRunTurnRecord({
        input: input(),
        triggerId: "trg_1",
        environmentRef: { environmentId: "env_1", name: "", revision: 3 },
      }),
    ).not.toHaveProperty("environmentAtTurn");
  });
});

describe("the executor stamps the record on the run's turn", () => {
  function memoryPort() {
    const persisted: Array<Parameters<TranscriptPort["persist"]>[0]> = [];
    const port: TranscriptPort = {
      load: vi.fn(async () => null),
      persist: vi.fn(async (options) => {
        persisted.push(options);
        return { outcome: "saved" as const, version: 1 };
      }),
    };
    return { port, persisted };
  }

  it("writes the event, the environment and an empty skill list", async () => {
    const { port, persisted } = memoryPort();
    const claim: EventRunClaim = {
      run: { _id: "run_1", projectId: "proj_1", triggerId: "trg_1", subscriptionId: "sub_doc_1" },
      token: "lease",
      input: input({ origin: "simulation" }, { mode: "push" }),
      messages: null,
      step: 0,
      calls: [],
      ownerExternalId: "user_1",
      organizationId: "org_1",
    };
    const deps: EventExecutorDeps = {
      backend: {
        claimRun: vi.fn(async () => null),
        checkpointRun: vi.fn(async () => {}),
        beginCall: vi.fn(async () => ({ replay: false })),
        finishCall: vi.fn(async () => {}),
        finishRun: vi.fn(async () => {}),
      },
      transcript: port,
      getBearer: async () => "jwt",
      resolveServers: async () => ({
        serverIds: ["srv_events"],
        environmentRef: { environmentId: "env_1", name: "Staging", revision: 2 },
      }),
      connect: async () => ({
        manager: { getAllToolAnnotations: () => ({}) } as never,
        close: async () => {},
      }),
      resolveModel: async () => ({ id: "m", name: "M", provider: "openai" }) as never,
      prepareChat: async () => ({ allTools: {}, enhancedSystemPrompt: "sys" }),
      resolveRuntime: async () => ({ runtime: { kind: "direct" } as never }),
      runTurn: async () => ({
        messages: [],
        newMessages: [{ role: "assistant", content: "Done." }],
        toolCalls: [],
        toolResults: [],
        turnTrace: {
          turnId: "engine-turn",
          promptIndex: 0,
          startedAt: 1,
          endedAt: 2,
          spans: [],
          modelId: "m",
        },
      }),
    };

    const outcome = await executeClaimedEventRun(claim, deps);

    expect(outcome.status).toBe("completed");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.turnTrace).toMatchObject({
      turnId: "event-run-run_1",
      eventAtTurn: {
        name: "comment.created",
        origin: "simulation",
        delivery: "push",
        subscriptionId: "esub_1",
        triggerId: "trg_1",
        receivedAt: 1_700_000_000_000,
      },
      environmentAtTurn: { environmentId: "env_1", name: "Staging", revision: 2 },
      skillsAtTurn: [],
    });
  });
});
