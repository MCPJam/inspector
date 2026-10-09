import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createJourneyRun,
  finalizePendingAttempts,
  previewSwarmFunding,
  reportTargetGrounding,
  swarmPersonaNextTurn,
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

  it("honors an explicit cancellation flag even while stored status is running", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, status: "running", cancelRequested: true })));
    expect(await heartbeatJourneyRun(CONVEX_HTTP_URL, "token", { projectId: "proj-1", runId: "run-1" })).toBe("failed");
  });

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
    // The exact capability list below depends on whether a service token is
    // set: the sponsorship capability is declared only with one. Pin it unset
    // so the contract does not change with the shell the suite runs in.
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
      runtimeVenue: "hosted",
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

describe("swarm-agent sponsored swarm allowance — capability negotiation", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const createBody = () => JSON.parse(fetchMock.mock.calls[0]![1].body);
  const CREATE_ARGS = {
    projectId: "proj-1",
    journeyRefId: "journey-1",
    launchKey: "lk-1",
  };

  it("does not advertise swarm-sponsorship-v1 without INSPECTOR_SERVICE_TOKEN", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    fetchMock.mockResolvedValue(Response.json(okCreateResponse()));

    await createJourneyRun(CONVEX_HTTP_URL, "token", CREATE_ARGS);

    expect(createBody().runnerCapabilities).not.toContain(
      "swarm-sponsorship-v1",
    );
  });

  it("advertises swarm-sponsorship-v1 when INSPECTOR_SERVICE_TOKEN is set", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
    fetchMock.mockResolvedValue(Response.json(okCreateResponse()));

    await createJourneyRun(CONVEX_HTTP_URL, "token", CREATE_ARGS);

    expect(createBody().runnerCapabilities).toContain("swarm-sponsorship-v1");
  });

  it("names the harnesses of a local launch beside the sponsorship capability", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
    fetchMock.mockResolvedValue(Response.json(okCreateResponse()));

    await createJourneyRun(CONVEX_HTTP_URL, "token", {
      ...CREATE_ARGS,
      runtimeVenue: "local",
      localHarnessIds: ["codex", "claude-code"],
    });

    expect(createBody().runnerCapabilities).toEqual([
      ...runnerCapabilities(),
      "swarm-standard-checks-v1",
      "local-harness:claude-code",
      "local-harness:codex",
      "swarm-sponsorship-v1",
    ]);
  });

  it("names no local harness on a hosted launch, whatever the caller passes", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    fetchMock.mockResolvedValue(Response.json(okCreateResponse()));

    await createJourneyRun(CONVEX_HTTP_URL, "token", {
      ...CREATE_ARGS,
      localHarnessIds: ["codex"],
    });

    expect(
      createBody().runnerCapabilities.some((capability: string) =>
        capability.startsWith("local-harness:"),
      ),
    ).toBe(false);
  });

  // The backend drops swarm-sponsorship-v1 from a request that does not carry
  // the service token, so the declaration and the proof travel together.
  const createHeaders = () =>
    fetchMock.mock.calls[0]![1].headers as Record<string, string>;

  it("attests the declared capability with the service token on run creation", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", " svc-token\n");
    fetchMock.mockResolvedValue(Response.json(okCreateResponse()));

    await createJourneyRun(CONVEX_HTTP_URL, "user-bearer", CREATE_ARGS);

    expect(createBody().runnerCapabilities).toContain("swarm-sponsorship-v1");
    expect(createHeaders()["x-inspector-service-token"]).toBe("svc-token");
    expect(createHeaders().Authorization).toBe("Bearer user-bearer");
  });

  it("sends no service token on run creation when it does not declare the capability", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    fetchMock.mockResolvedValue(Response.json(okCreateResponse()));

    await createJourneyRun(CONVEX_HTTP_URL, "user-bearer", CREATE_ARGS);

    expect(createHeaders()).not.toHaveProperty("x-inspector-service-token");
  });

  it("sends expectedSponsored only when the caller supplied it, including zero", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(okCreateResponse()),
    );

    await createJourneyRun(CONVEX_HTTP_URL, "token", CREATE_ARGS);
    await createJourneyRun(CONVEX_HTTP_URL, "token", {
      ...CREATE_ARGS,
      expectedSponsored: 0,
    });

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).not.toHaveProperty(
      "expectedSponsored",
    );
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).expectedSponsored).toBe(
      0,
    );
  });

  it("parses funding and per-session funding off the create response", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...okCreateResponse(),
        funding: { sponsored: 1, credits: 1, total: 2 },
        sessions: [
          { targetId: "t1", sessionIdx: 0, funding: "starter" },
          { targetId: "t1", sessionIdx: 1, funding: "credits" },
          { targetId: "t1", sessionIdx: 2, funding: "bogus" },
        ],
      }),
    );

    const created = await createJourneyRun(
      CONVEX_HTTP_URL,
      "token",
      CREATE_ARGS,
    );

    expect(created.funding).toEqual({ sponsored: 1, credits: 1, total: 2 });
    expect(created.sessions).toEqual([
      { targetId: "t1", sessionIdx: 0, funding: "starter" },
      { targetId: "t1", sessionIdx: 1, funding: "credits" },
    ]);
  });

  it("leaves funding absent for a backend that predates sponsorship", async () => {
    fetchMock.mockResolvedValue(Response.json(okCreateResponse()));

    const created = await createJourneyRun(
      CONVEX_HTTP_URL,
      "token",
      CREATE_ARGS,
    );

    expect(created.funding).toBeUndefined();
    expect(created.sessions).toBeUndefined();
  });

  it("previews as unsupported without asking the backend when the server has no service token", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");

    const preview = await previewSwarmFunding(CONVEX_HTTP_URL, "token", {
      projectId: "proj-1",
      runs: [{ journeyRefId: "j1" }],
    });

    expect(preview).toEqual({
      supported: false,
      remaining: 0,
      granted: 0,
      runs: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("previews through the backend with the same capability list a launch declares", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
    fetchMock.mockResolvedValue(
      Response.json({
        supported: true,
        remaining: 12,
        granted: 500,
        runs: [
          {
            sponsored: 5,
            credits: 10,
            total: 15,
            targets: [{ targetId: "t1", eligible: false, reason: "harness" }],
          },
        ],
      }),
    );

    const preview = await previewSwarmFunding(CONVEX_HTTP_URL, "token", {
      projectId: "proj-1",
      runs: [{ journeyRefId: "j1", sessionsPerTarget: 3, kind: "swarm" }],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      `${CONVEX_HTTP_URL}/journey-execution/funding-preview`,
    );
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.runnerCapabilities).toContain("swarm-sponsorship-v1");
    // The preview must see the allocation a launch would get, so it is
    // attested exactly like the launch; unattested, the backend would answer
    // for a runner that cannot be sponsored.
    expect(
      (init as RequestInit & { headers: Record<string, string> }).headers[
        "x-inspector-service-token"
      ],
    ).toBe("svc-token");
    // The kind rides to the backend: it resolves an omitted one from the
    // session count, which is not how the wizard's launch resolves it.
    expect(body.runs).toEqual([
      { journeyRefId: "j1", sessionsPerTarget: 3, kind: "swarm" },
    ]);
    expect(preview).toEqual({
      supported: true,
      remaining: 12,
      granted: 500,
      runs: [
        {
          sponsored: 5,
          credits: 10,
          total: 15,
          targets: [{ targetId: "t1", eligible: false, reason: "harness" }],
        },
      ],
    });
  });

  it("reads a backend without the preview route as unsupported", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));

    await expect(
      previewSwarmFunding(CONVEX_HTTP_URL, "token", {
        projectId: "proj-1",
        runs: [{ journeyRefId: "j1" }],
      }),
    ).resolves.toMatchObject({ supported: false, remaining: 0 });
  });
});

describe("swarm-agent sponsored swarm allowance — service token on sponsored calls", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () =>
      Response.json({ ok: true, message: "hi", endSession: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const PERSONA = {
    projectId: "p",
    runId: "r",
    hostId: "h",
    sessionIdx: 0,
    transcriptSoFar: [],
  };
  const headersOf = (call: number) =>
    fetchMock.mock.calls[call]![1].headers as Record<string, string>;

  it("attaches x-inspector-service-token to a sponsored persona turn", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", " svc-token\n");
    await swarmPersonaNextTurn(CONVEX_HTTP_URL, "bearer", {
      ...PERSONA,
      sponsored: true,
    });
    expect(headersOf(0)["x-inspector-service-token"]).toBe("svc-token");
    expect(headersOf(0).Authorization).toBe("Bearer bearer");
  });

  it("does not attach it to a credit-funded persona turn", async () => {
    await swarmPersonaNextTurn(CONVEX_HTTP_URL, "bearer", PERSONA);
    expect(headersOf(0)).not.toHaveProperty("x-inspector-service-token");
  });

  it("attaches it to sponsored grounding only", async () => {
    await reportTargetGrounding(
      CONVEX_HTTP_URL,
      "bearer",
      { runId: "r" } as never,
      undefined,
      true,
    );
    await reportTargetGrounding(CONVEX_HTTP_URL, "bearer", {
      runId: "r",
    } as never);
    expect(headersOf(0)["x-inspector-service-token"]).toBe("svc-token");
    expect(headersOf(1)).not.toHaveProperty("x-inspector-service-token");
  });

  it.each(["", " \t\n"])(
    "refuses a sponsored call with a blank credential %j instead of sending it bare",
    async (credential) => {
      vi.stubEnv("INSPECTOR_SERVICE_TOKEN", credential);
      await expect(
        swarmPersonaNextTurn(CONVEX_HTTP_URL, "bearer", {
          ...PERSONA,
          sponsored: true,
        }),
      ).rejects.toThrow(/swarm_sponsorship_rejected/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("swarm-agent finalizePendingAttempts — funding scope", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodyOf = () => JSON.parse(fetchMock.mock.calls[0]![1].body);

  it("sends fundingScope only when asked, so a spend cap can leave sponsored attempts alone", async () => {
    await finalizePendingAttempts(CONVEX_HTTP_URL, "t", {
      projectId: "p",
      runId: "r",
      terminalStatus: "rate_limited",
      errorCode: "spend_cap_exceeded",
      fundingScope: "credits",
    });
    expect(bodyOf()).toMatchObject({
      runId: "r",
      errorCode: "spend_cap_exceeded",
      fundingScope: "credits",
    });

    fetchMock.mockClear();
    await finalizePendingAttempts(CONVEX_HTTP_URL, "t", {
      projectId: "p",
      runId: "r",
    });
    expect(bodyOf()).not.toHaveProperty("fundingScope");
  });

  it("sends the sponsored scope with its target, and no target unless asked", async () => {
    await finalizePendingAttempts(CONVEX_HTTP_URL, "t", {
      projectId: "p",
      runId: "r",
      terminalStatus: "failed",
      errorCode: "prerequisites_unavailable",
      fundingScope: "sponsored",
      targetId: "target-a",
    });
    expect(bodyOf()).toMatchObject({
      runId: "r",
      terminalStatus: "failed",
      errorCode: "prerequisites_unavailable",
      fundingScope: "sponsored",
      targetId: "target-a",
    });

    fetchMock.mockClear();
    await finalizePendingAttempts(CONVEX_HTTP_URL, "t", {
      projectId: "p",
      runId: "r",
    });
    expect(bodyOf()).not.toHaveProperty("targetId");
  });
});

it("preserves the canceled attempt response for runner control", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, applied: false, canceled: true })));
  try {
    expect(await reportAttempt(CONVEX_HTTP_URL, "token", { projectId: "proj-1", runId: "run-1", hostId: "host-1", sessionIdx: 0, status: "running", chatSessionId: "session-1" })).toEqual({ ok: true, applied: false, canceled: true });
  } finally { vi.unstubAllGlobals(); }
});
