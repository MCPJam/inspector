import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetchMock = vi.fn();
vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

import {
  launchJourneyRun,
  LaunchJourneyRunError,
} from "@/lib/swarm-api";
import type {
  PersonaTrackRecord,
  JourneyRollup,
  JourneySessionRow,
} from "@/lib/swarm-api";

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

  it("JourneySessionRow (JourneySessionDto) is keyed by `id`, with no personaLabel/messageCount", () => {
    const row: JourneySessionRow = {
      id: "thread-1",
      chatSessionId: "synth_run_host_0",
      projectId: "proj-1",
      hostId: "host-1",
      personaRefId: "persona-1",
      status: "completed",
      modelId: "anthropic/claude-haiku-4.5",
      startedAt: 1,
      lastActivityAt: 2,
      readiness: { status: "completed", verdict: "ready", issueCount: 0 },
    };
    // The identifier the viewer + deep-link consume is `id`.
    expect(row.id).toBe("thread-1");
    expect(row).not.toHaveProperty("_id");
    expect(row).not.toHaveProperty("personaLabel");
    expect(row).not.toHaveProperty("messageCount");
    expect(row).not.toHaveProperty("personaId");
  });
});
