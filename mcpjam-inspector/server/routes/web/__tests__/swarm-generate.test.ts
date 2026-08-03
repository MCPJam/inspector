import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp, postJson, expectJson } from "./helpers/test-app.js";
import { SwarmAgentError } from "../../../services/swarm-agent.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

const generateSwarmPersonaMock = vi.fn();
const generateSwarmJourneysMock = vi.fn();

vi.mock("../../../services/swarm-generate.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/swarm-generate.js")
  >("../../../services/swarm-generate.js");
  return {
    ...actual,
    generateSwarmPersona: (...args: unknown[]) =>
      generateSwarmPersonaMock(...args),
    generateSwarmJourneys: (...args: unknown[]) =>
      generateSwarmJourneysMock(...args),
  };
});

describe("web routes — swarm generation proxy", () => {
  const { app, token } = createWebTestApp();

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://test-deployment.convex.site";
    generateSwarmPersonaMock.mockReset();
    generateSwarmJourneysMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
  });

  it("generates a persona + journeys, defaulting journeyCount to 3", async () => {
    generateSwarmPersonaMock.mockResolvedValue({
      persona: {
        name: "Curious First-Time User",
        role: "Hobbyist",
        notes: "n",
      },
      journeys: [{ name: "J1", goal: "Do the thing." }],
    });

    const response = await postJson(
      app,
      "/api/web/swarm/generate/persona",
      { projectId: "proj-1", serverAttachmentId: "att-1" },
      token
    );
    const { status, data } = await expectJson<{
      persona?: { name: string };
      journeys?: unknown[];
    }>(response);

    expect(status).toBe(200);
    expect(data.persona?.name).toBe("Curious First-Time User");
    expect(data.journeys).toHaveLength(1);

    expect(generateSwarmPersonaMock).toHaveBeenCalledTimes(1);
    const args = generateSwarmPersonaMock.mock.calls[0]![2] as any;
    expect(args).toMatchObject({
      projectId: "proj-1",
      serverAttachmentId: "att-1",
      journeyCount: 3,
    });
  });

  it("generates journeys for an inline persona with the requested count", async () => {
    generateSwarmJourneysMock.mockResolvedValue({
      journeys: [{ goal: "one" }, { goal: "two" }],
    });

    const response = await postJson(
      app,
      "/api/web/swarm/generate/journeys",
      {
        projectId: "proj-1",
        serverAttachmentId: "att-1",
        journeyCount: 2,
        persona: { name: "P", role: "R", notes: "N" },
      },
      token
    );
    const { status, data } = await expectJson<{ journeys?: unknown[] }>(
      response
    );

    expect(status).toBe(200);
    expect(data.journeys).toHaveLength(2);
    const args = generateSwarmJourneysMock.mock.calls[0]![2] as any;
    expect(args).toMatchObject({
      journeyCount: 2,
      persona: { name: "P", role: "R", notes: "N" },
    });
  });

  it("rejects an out-of-range journeyCount with 400 before calling the backend", async () => {
    const response = await postJson(
      app,
      "/api/web/swarm/generate/persona",
      { projectId: "proj-1", serverAttachmentId: "att-1", journeyCount: 9 },
      token
    );
    expect(response.status).toBe(400);
    expect(generateSwarmPersonaMock).not.toHaveBeenCalled();
  });

  it("forwards environmentId grounding to the backend service", async () => {
    generateSwarmPersonaMock.mockResolvedValue({
      persona: { name: "P", role: "R" },
      journeys: [{ goal: "g" }],
    });

    const response = await postJson(
      app,
      "/api/web/swarm/generate/persona",
      { projectId: "proj-1", environmentId: "env-1" },
      token
    );
    expect(response.status).toBe(200);
    expect(generateSwarmPersonaMock).toHaveBeenCalledWith(
      "https://test-deployment.convex.site",
      expect.any(String),
      expect.objectContaining({ projectId: "proj-1", environmentId: "env-1" })
    );
    const args = generateSwarmPersonaMock.mock.calls[0]![2] as Record<
      string,
      unknown
    >;
    expect("serverAttachmentId" in args).toBe(false);
  });

  it("rejects a whitespace-only grounding id before calling the backend", async () => {
    const response = await postJson(
      app,
      "/api/web/swarm/generate/persona",
      { projectId: "proj-1", environmentId: "   " },
      token
    );
    expect(response.status).toBe(400);
    expect(generateSwarmPersonaMock).not.toHaveBeenCalled();
  });

  it("rejects a body with BOTH grounding sources before calling the backend", async () => {
    const response = await postJson(
      app,
      "/api/web/swarm/generate/persona",
      {
        projectId: "proj-1",
        serverAttachmentId: "att-1",
        environmentId: "env-1",
      },
      token
    );
    expect(response.status).toBe(400);
    expect(generateSwarmPersonaMock).not.toHaveBeenCalled();
  });

  it("rejects a body with NEITHER grounding source before calling the backend", async () => {
    const response = await postJson(
      app,
      "/api/web/swarm/generate/journeys",
      {
        projectId: "proj-1",
        persona: { name: "P", role: "R" },
      },
      token
    );
    expect(response.status).toBe(400);
    expect(generateSwarmJourneysMock).not.toHaveBeenCalled();
  });

  it("rejects generate-journeys without a persona", async () => {
    const response = await postJson(
      app,
      "/api/web/swarm/generate/journeys",
      { projectId: "proj-1", serverAttachmentId: "att-1" },
      token
    );
    expect(response.status).toBe(400);
    expect(generateSwarmJourneysMock).not.toHaveBeenCalled();
  });

  it("passes the backend 429 quota status and message through", async () => {
    generateSwarmPersonaMock.mockRejectedValue(
      new SwarmAgentError(
        429,
        JSON.stringify({ ok: false, code: "user_rate_limit" }),
        "You've hit your usage limit for today."
      )
    );

    const response = await postJson(
      app,
      "/api/web/swarm/generate/persona",
      { projectId: "proj-1", serverAttachmentId: "att-1" },
      token
    );
    const { status, data } = await expectJson<{
      code?: string;
      message?: string;
    }>(response);
    expect(status).toBe(429);
    expect(data.message).toContain("You've hit your usage limit for today.");
    // Code-based clients branch on this to reach standard rate-limit handling;
    // a generic VALIDATION_ERROR would strand them on a 429.
    expect(data.code).toBe("RATE_LIMITED");
  });

  it("maps a backend 5xx onto 500 and keeps the upstream detail out of the body", async () => {
    generateSwarmJourneysMock.mockRejectedValue(
      new SwarmAgentError(502, "", "swarm-generate upstream failed (502)")
    );

    const response = await postJson(
      app,
      "/api/web/swarm/generate/journeys",
      {
        projectId: "proj-1",
        serverAttachmentId: "att-1",
        persona: { name: "P", role: "R" },
      },
      token
    );
    // Exactly 500 — a 5xx SwarmAgentError must NOT be rethrown at its own
    // status the way the 4xx branch forwards one.
    const { status, data } = await expectJson<Record<string, unknown>>(
      response
    );
    expect(status).toBe(500);
    expect(JSON.stringify(data)).not.toContain(
      "swarm-generate upstream failed"
    );
  });

  it("requires a bearer token", async () => {
    const response = await postJson(app, "/api/web/swarm/generate/persona", {
      projectId: "proj-1",
      serverAttachmentId: "att-1",
    });
    expect(response.status).toBe(401);
    expect(generateSwarmPersonaMock).not.toHaveBeenCalled();
  });
});
