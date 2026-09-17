import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createJourneyRun,
  fetchPinnedSkill,
  PinnedSkillIntegrityError,
  reportAttempt,
  heartbeatJourneyRun,
} from "../swarm-agent.js";
import { runnerCapabilities } from "../evals/runner-capabilities.js";

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

describe("swarm-agent heartbeat — backend lifecycle response", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    "running",
    "failed",
    "completed",
    "partial",
    "rate_limited",
    "missing",
    undefined,
  ])(
    "preserves status %s so the runner can stop when Convex ends the run",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(Response.json({ ok: true, status })),
      );
      expect(
        await heartbeatJourneyRun(CONVEX_HTTP_URL, "token", {
          projectId: "proj-1",
          runId: "run-1",
        }),
      ).toBe(status);
    },
  );

  it("rejects an unrecognized status instead of stopping a healthy run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ok: true, status: "unexpected" })),
    );
    await expect(
      heartbeatJourneyRun(CONVEX_HTTP_URL, "token", {
        projectId: "proj-1",
        runId: "run-1",
      }),
    ).rejects.toThrow("Invalid run status");
  });
});

function okCreateResponse() {
  return {
    ok: true,
    runId: "run-1",
    projectId: "proj-1",
    journeyRefId: "journey-1",
    snapshot: {
      hosts: [],
      personaSnapshot: { personaId: "p1", name: "P", role: "r", notes: "" },
      sessionsPerTarget: 1,
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
      kind: "swarm",
      // ASSERTED BY THIS PROCESS, never taken from the caller's args above: we
      // are the runner, so we are the only honest source for what we can
      // execute. The backend reads it to decide whether an environment's
      // materialized secrets make this wave unrunnable.
      // The swarm path appends its own: the backend reads it to know this
      // runner grades standard checks itself.
      runnerCapabilities: [...runnerCapabilities(), "swarm-standard-checks-v1"],
    });
    // projectId is the field whose omission would produce the guaranteed 400.
    expect(body.projectId).toBe("proj-1");

    // And the bearer is forwarded as a JWT for the JWT-only Convex HTTP action.
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer bearer-token");
  });
  it("serializes an explicit standalone run kind", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(okCreateResponse())),
    );
    await createJourneyRun(CONVEX_HTTP_URL, "token", {
      projectId: "proj-1",
      journeyRefId: "journey-1",
      launchKey: "lk-2",
      kind: "user_testing",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).kind).toBe(
      "user_testing",
    );
  });
  it("serializes a per-run iterations override", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(okCreateResponse())),
    );
    await createJourneyRun(CONVEX_HTTP_URL, "token", {
      projectId: "proj-1",
      journeyRefId: "journey-1",
      launchKey: "lk-3",
      sessionsPerTarget: 1,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).sessionsPerTarget).toBe(
      1,
    );
  });
});

describe("swarm-agent fetchPinnedSkill — wire contract", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const okSkill = (contentHash: string) => ({
    ok: true,
    skill: {
      name: "sk",
      description: "d",
      content: "# body",
      contentHash,
    },
  });

  it("GETs /journey-execution/runs/skill with URL-ENCODED query params + bearer", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(okSkill("h 1+2")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const skill = await fetchPinnedSkill(CONVEX_HTTP_URL, "bearer-token", {
      projectId: "proj/1",
      runId: "run-1",
      targetId: "environment:env&1",
      contentHash: "h 1+2",
    });
    expect(skill.content).toBe("# body");

    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/journey-execution/runs/skill");
    // Decoded params round-trip the raw values — i.e. they were encoded.
    expect(parsed.searchParams.get("projectId")).toBe("proj/1");
    expect(parsed.searchParams.get("targetId")).toBe("environment:env&1");
    expect(parsed.searchParams.get("contentHash")).toBe("h 1+2");
    expect(parsed.searchParams.get("runId")).toBe("run-1");
    expect((init as RequestInit).method).toBe("GET");
    expect(
      new Headers((init as RequestInit).headers).get("Authorization")
    ).toBe("Bearer bearer-token");
  });

  it("surfaces a 404 as SwarmAgentError with status 404 (non-retryable downstream)", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, code: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    );
    await expect(
      fetchPinnedSkill(CONVEX_HTTP_URL, "b", {
        projectId: "p",
        runId: "r",
        targetId: "t",
        contentHash: "h",
      })
    ).rejects.toMatchObject({ name: "SwarmAgentError", status: 404 });
  });

  it("rejects a served hash that does not match the requested one (integrity)", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(okSkill("other-hash")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await expect(
      fetchPinnedSkill(CONVEX_HTTP_URL, "b", {
        projectId: "p",
        runId: "r",
        targetId: "t",
        contentHash: "requested-hash",
      })
    ).rejects.toBeInstanceOf(PinnedSkillIntegrityError);
  });
});

describe("swarm-agent reportAttempt — targetId echo", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("spreads targetId into the body when present and omits it when absent", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true, applied: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    await reportAttempt(CONVEX_HTTP_URL, "b", {
      projectId: "p",
      runId: "r",
      hostId: "h",
      targetId: "environment:e1",
      sessionIdx: 0,
      status: "running",
      chatSessionId: "synth_r_env_e1_0",
    });
    const withTarget = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string
    );
    expect(withTarget.targetId).toBe("environment:e1");
    expect(withTarget.hostId).toBe("h");

    await reportAttempt(CONVEX_HTTP_URL, "b", {
      projectId: "p",
      runId: "r",
      hostId: "h",
      sessionIdx: 0,
      status: "running",
      chatSessionId: "synth_r_h_0",
    });
    const withoutTarget = JSON.parse(
      (fetchMock.mock.calls[1]![1] as RequestInit).body as string
    );
    expect("targetId" in withoutTarget).toBe(false);
  });
});
