import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetchMock = vi.fn();
vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

import {
  groupSwarmSessionsByGoal,
  groupSwarmSessionsByRun,
  journeySessionRowToThread,
  launchJourneyRun,
  LaunchJourneyRunError,
  generateSwarmPersonaBatch,
  SwarmGenerateError,
} from "@/lib/swarm-api";
import type {
  PersonaTrackRecord,
  JourneyRollup,
  JourneySessionRow,
} from "@/lib/swarm-api";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  authFetchMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("launchJourneyRun", () => {
  it("POSTs to the swarm REST route with projectId + launchKey and returns the runId on 202", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(202, { runId: "run-1" }));

    const result = await launchJourneyRun({
      journeyId: "journey-1",
      projectId: "proj-1",
      launchKey: "lk-abc",
    });

    expect(result).toEqual({ runId: "run-1" });
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = authFetchMock.mock.calls[0]!;
    expect(url).toBe("/api/web/swarm/journeys/journey-1/runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      projectId: "proj-1",
      launchKey: "lk-abc",
    });
  });

  it("url-encodes the journeyId path segment", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(202, { runId: "run-2" }));
    await launchJourneyRun({
      journeyId: "a/b?c",
      projectId: "proj-1",
      launchKey: "lk",
    });
    expect(authFetchMock.mock.calls[0]![0]).toBe(
      "/api/web/swarm/journeys/a%2Fb%3Fc/runs"
    );
  });

  it("throws a LaunchJourneyRunError carrying the 4xx status + backend message", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse(400, { code: "VALIDATION_ERROR", message: "This journey has no pinned hosts to run" })
    );

    await expect(
      launchJourneyRun({
        journeyId: "journey-1",
        projectId: "proj-1",
        launchKey: "lk",
      })
    ).rejects.toMatchObject({
      name: "LaunchJourneyRunError",
      status: 400,
      message: "This journey has no pinned hosts to run",
    });
  });

  it("falls back to a generic message when the error body has none", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(500, {}));
    let err: unknown;
    try {
      await launchJourneyRun({
        journeyId: "j",
        projectId: "p",
        launchKey: "lk",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LaunchJourneyRunError);
    expect((err as LaunchJourneyRunError).status).toBe(500);
    expect((err as LaunchJourneyRunError).message).toMatch(/500/);
  });

  it("throws when a 2xx returns no runId", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(202, {}));
    await expect(
      launchJourneyRun({ journeyId: "j", projectId: "p", launchKey: "lk" })
    ).rejects.toBeInstanceOf(LaunchJourneyRunError);
  });
});

/**
 * CONTRACT: the client DTOs must match the backend `personas:getPersonaTrackRecord`
 * / `journeys:getJourneyRollup` / `listSessionsBy*` shapes EXACTLY. The object
 * literals below are checked structurally by TS (excess-property check fails on
 * a wrong/extra key), and `Object.keys` asserts the shape at runtime. These are
 * the fixtures a real backend row would deserialize into — if the backend key
 * set drifts, this fails instead of silently rendering blank counts.
 */
describe("swarm rollup DTO contracts", () => {
  it("PersonaTrackRecord = { personaRefId, runCount, sessionCount, readiness, sessionExamples }", () => {
    const record: PersonaTrackRecord = {
      personaRefId: "persona-1",
      runCount: 3,
      sessionCount: 12,
      readiness: { ready: 8, needsAttention: 3, notReady: 1 },
      sessionExamples: [{ chatSessionId: "synth_1" }],
    };
    expect(Object.keys(record).sort()).toEqual(
      [
        "personaRefId",
        "readiness",
        "runCount",
        "sessionCount",
        "sessionExamples",
      ].sort()
    );
    // The old (wrong) keys must be gone.
    expect(record).not.toHaveProperty("totalRuns");
    expect(record).not.toHaveProperty("totalSessions");
    expect(record).not.toHaveProperty("hostBreakdown");
  });

  it("JourneyRollup = { journeyRefId, runCount, hosts[] } with the per-host outcome rollup", () => {
    const rollup: JourneyRollup = {
      journeyRefId: "journey-1",
      runCount: 2,
      hosts: [
        {
          hostId: "host-1",
          total: 4,
          succeeded: 3,
          failed: 1,
          rateLimited: 0,
          readiness: { ready: 3 },
        },
      ],
    };
    expect(Object.keys(rollup).sort()).toEqual(
      ["hosts", "journeyRefId", "runCount"].sort()
    );
    expect(Object.keys(rollup.hosts[0]!).sort()).toEqual(
      ["failed", "hostId", "rateLimited", "readiness", "succeeded", "total"].sort()
    );
    // Not the old flat `hostSummaries` / `totalRuns`.
    expect(rollup).not.toHaveProperty("hostSummaries");
    expect(rollup).not.toHaveProperty("totalRuns");
  });

  it("JourneySessionRow (JourneySessionDto) is keyed by `id` and carries Sessions-tab list fields", () => {
    const row: JourneySessionRow = {
      id: "thread-1",
      chatSessionId: "synth_run_host_0",
      projectId: "proj-1",
      hostId: "host-1",
      personaRefId: "persona-1",
      journeyRunId: "run-1",
      journeyRefId: "journey-1",
      status: "completed",
      modelId: "anthropic/claude-haiku-4.5",
      startedAt: 1,
      lastActivityAt: 2,
      messageCount: 4,
      firstMessagePreview: "hello",
      personaLabel: "Persona One",
      visitorDisplayName: "Persona One",
      synthetic: true,
      readiness: { status: "completed", verdict: "ready", issueCount: 0 },
    };
    // The identifier the viewer + deep-link consume is `id`.
    expect(row.id).toBe("thread-1");
    expect(row).not.toHaveProperty("_id");
    expect(row).not.toHaveProperty("personaId");
    expect(row.messageCount).toBe(4);
    expect(row.personaLabel).toBe("Persona One");
    expect(row.journeyRunId).toBe("run-1");
  });

  it("journeySessionRowToThread maps list rows into ShareUsageThreadList shape", () => {
    const thread = journeySessionRowToThread(
      {
        id: "thread-1",
        chatSessionId: "synth_1",
        projectId: "proj-1",
        hostId: "host-1",
        personaRefId: "persona-1",
        startedAt: 10,
        messageCount: 3,
        firstMessagePreview: "hi",
      },
      "Fallback Name",
    );
    expect(thread).toMatchObject({
      _id: "thread-1",
      sourceType: "swarm",
      visitorDisplayName: "Fallback Name",
      synthetic: true,
      messageCount: 3,
      personaLabel: "Fallback Name",
    });
  });

  it("groupSwarmSessionsByRun clusters rows by journeyRunId, newest run first", () => {
    const row = (
      id: string,
      runId: string | undefined,
      lastActivityAt: number,
    ): JourneySessionRow =>
      ({
        id,
        chatSessionId: `synth_${id}`,
        projectId: "proj-1",
        journeyRunId: runId,
        startedAt: lastActivityAt - 100,
        lastActivityAt,
        messageCount: 1,
      }) as JourneySessionRow;

    const groups = groupSwarmSessionsByRun([
      row("a", "run-old", 100),
      row("b", "run-new", 300),
      row("c", "run-new", 200),
      row("d", undefined, 50),
    ]);

    expect(groups.map((g) => g.runId)).toEqual(["run-new", "run-old", null]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["b", "c"]);
    expect(groups[2].rows.map((r) => r.id)).toEqual(["d"]);
  });

  it("groupSwarmSessionsByGoal clusters rows by journeyRefId, newest first", () => {
    const row = (
      id: string,
      journeyRefId: string | undefined,
      lastActivityAt: number,
    ): JourneySessionRow =>
      ({
        id,
        chatSessionId: `synth_${id}`,
        projectId: "proj-1",
        journeyRefId,
        startedAt: lastActivityAt - 100,
        lastActivityAt,
        messageCount: 1,
      }) as JourneySessionRow;

    const groups = groupSwarmSessionsByGoal([
      row("a", "goal-old", 100),
      row("b", "goal-new", 300),
      row("c", "goal-new", 200),
      row("d", undefined, 50),
    ]);

    expect(groups.map((g) => g.runId)).toEqual(["goal-new", "goal-old", null]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["b", "c"]);
    expect(groups[2].rows.map((r) => r.id)).toEqual(["d"]);
  });
});

/**
 * The MCPJam cap during persona GENERATION — the surface BB-151 was reported
 * from, which is the Describe step and not a running swarm.
 *
 * `SwarmGenerateError` keeps only status + message, so a limit recognized any
 * later than this reads as an unclassified failure and renders as the error
 * catalog's "Unknown error". Raising it here also covers every other
 * generation call, which share this one helper.
 */
describe("generateSwarmPersonaBatch — MCPJam limit", () => {
  beforeEach(() => {
    useMCPJamLimitDialogStore.setState({
      isOpen: false,
      hasPendingLimit: false,
      outOfCreditsHit: false,
      outOfCreditsOrganizationId: null,
      intent: null,
      organizationId: null,
      pendingInput: null,
      surface: null,
      // Not incidental: `notifyLimitHit` only reaches `isOpen` once an auth
      // status is known. Left at the store's default `"loading"` these tests
      // would pass on the pending branch without the dialog ever opening.
      authStatus: "signedIn",
    });
  });

  const generate = () =>
    generateSwarmPersonaBatch({
      projectId: "proj-1",
      environmentId: "env-1",
      personaCount: 3,
      journeyCount: 5,
    });

  it("raises the top-up dialog on the daily cap, and still throws", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse(429, {
        ok: false,
        code: "user_rate_limit",
        limitKind: "total",
        message: "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
      })
    );

    let err: unknown;
    try {
      await generate();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SwarmGenerateError);
    // The create flow reads this to stay out of the dialog's way: the modal
    // carries the same sentence plus the actions, so a card under the form
    // would repeat it with nothing to act on.
    expect((err as SwarmGenerateError).limitDialogRaised).toBe(true);
    // The dialog is OPEN, not merely flagged — the whole point is that the
    // user gets a way out without leaving the create flow.
    const state = useMCPJamLimitDialogStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.intent).toBe("topup");
    // Drives which actions the dialog offers: no swarm screen mounts the
    // model picker the BYOK link drives, so it must not be shown one.
    expect(state.surface).toBe("swarm");
    // Read off the message through the SDK catalog, the same classifier the
    // error card uses — so the modal can't tell a Free org its allowance
    // renews with the billing period.
    expect(state.period).toBe("daily");
  });

  it("carries the monthly period through for a Team org", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse(429, {
        ok: false,
        code: "user_rate_limit",
        limitKind: "total",
        message:
          "Monthly MCPJam model limit reached. Buy credits or wait for the next billing period.",
      })
    );

    await expect(generate()).rejects.toBeInstanceOf(SwarmGenerateError);
    // Telling this org to wait for tomorrow would be plain wrong — a monthly
    // allowance can be weeks from renewing.
    expect(useMCPJamLimitDialogStore.getState().period).toBe("monthly");
  });

  it("leaves an ordinary generation failure alone", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse(500, { message: "Generation backend is unavailable." })
    );

    let err: unknown;
    try {
      await generate();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SwarmGenerateError);
    // Nothing took this one over, so the create flow still cards it.
    expect((err as SwarmGenerateError).limitDialogRaised).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });
});
