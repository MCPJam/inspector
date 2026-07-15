import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJourneyRun } from "../swarm-agent.js";

/**
 * CONTRACT-LEVEL tests for the inspector→backend journey-execution boundary.
 *
 * These deliberately do NOT mock `createJourneyRun` itself — they intercept the
 * real `fetch` and assert the actual request BODY that crosses to the backend.
 * The backend `POST /journey-execution/runs/create` route reads `body.projectId`
 * and 400s without it, so a test that mocked the boundary away (asserting only
 * the JS arg object) would pass while the real launch guaranteed a 400. This
 * asserts the wire shape the backend actually parses.
 */

const CONVEX_HTTP_URL = "https://test-deployment.convex.site";

function okCreateResponse() {
  return {
    ok: true,
    runId: "run-1",
    projectId: "proj-1",
    journeyRefId: "journey-1",
    snapshot: {
      hosts: [],
      personaSnapshot: { personaId: "p1", name: "P", role: "r", notes: "" },
      sessionsPerHost: 1,
      maxTurns: 1,
    },
  };
}

describe("swarm-agent createJourneyRun — request-body contract", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs projectId + journeyRefId + launchKey + maxHosts in the JSON body", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(okCreateResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await createJourneyRun(CONVEX_HTTP_URL, "bearer-token", {
      projectId: "proj-1",
      journeyRefId: "journey-1",
      launchKey: "lk-1",
      maxHosts: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      `${CONVEX_HTTP_URL}/journey-execution/runs/create`
    );
    expect((init as RequestInit).method).toBe("POST");

    // The load-bearing assertion: the ACTUAL serialized body the backend parses.
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      projectId: "proj-1",
      journeyRefId: "journey-1",
      launchKey: "lk-1",
      maxHosts: 1,
    });
    // projectId is the field whose omission would produce the guaranteed 400.
    expect(body.projectId).toBe("proj-1");

    // And the bearer is forwarded as a JWT for the JWT-only Convex HTTP action.
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer bearer-token");
  });
});
