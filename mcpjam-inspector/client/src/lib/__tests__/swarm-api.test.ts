import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetchMock = vi.fn();
vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

import {
  launchJourneyRun,
  LaunchJourneyRunError,
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
