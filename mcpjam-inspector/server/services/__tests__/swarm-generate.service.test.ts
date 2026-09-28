/**
 * The generation service's error message is forwarded VERBATIM to the browser
 * by the web route on any 4xx, so it must never carry transport detail — in
 * particular the Convex deployment URL from CONVEX_HTTP_URL.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateSwarmJourneys,
  generateSwarmPersona,
  generateSwarmPersonaBatch,
} from "../swarm-generate.js";
import { SwarmAgentError } from "../swarm-agent.js";

const CONVEX_URL = "https://secret-deployment-1234.convex.site";

function mockFetchOnce(
  status: number,
  body: string,
  contentType = "text/html"
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
      headers: new Headers({ "content-type": contentType }),
    })) as unknown as typeof fetch
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("swarm-generate service — response shape validation", () => {
  function mockOk(body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
        headers: new Headers({ "content-type": "application/json" }),
      })) as unknown as typeof fetch
    );
  }

  const personaArgs = {
    projectId: "proj-1",
    serverAttachmentId: "att-1",
    journeyCount: 3,
  };

  it("rejects a journey element with no goal", async () => {
    // Would otherwise commit the persona, then have every journey mutation
    // reject the missing goal — stranding a journey-less persona.
    mockOk({ ok: true, persona: { name: "P", role: "R" }, journeys: [{}] });

    const err = await generateSwarmPersona(
      CONVEX_URL,
      "bearer",
      personaArgs
    ).catch((e) => e);

    expect(err).toBeInstanceOf(SwarmAgentError);
    expect(err.message).toContain("unexpected response");
  });

  it("rejects a persona missing role", async () => {
    mockOk({ ok: true, persona: { name: "P" }, journeys: [{ goal: "g" }] });

    const err = await generateSwarmPersona(
      CONVEX_URL,
      "bearer",
      personaArgs
    ).catch((e) => e);

    expect(err).toBeInstanceOf(SwarmAgentError);
  });

  it("rejects a null journey element in journeys mode", async () => {
    mockOk({ ok: true, journeys: [{ goal: "ok" }, null] });

    const err = await generateSwarmJourneys(CONVEX_URL, "bearer", {
      ...personaArgs,
      persona: { name: "P", role: "R" },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(SwarmAgentError);
  });

  it("clamps an over-delivered slate to the requested count", async () => {
    // The user's 1-5 choice is authoritative; an upstream that returns more
    // must not silently create extra rows.
    mockOk({
      ok: true,
      persona: { name: "P", role: "R" },
      journeys: [
        { goal: "1" },
        { goal: "2" },
        { goal: "3" },
        { goal: "4" },
        { goal: "5" },
      ],
    });

    const result = await generateSwarmPersona(CONVEX_URL, "bearer", {
      ...personaArgs,
      journeyCount: 2,
    });
    expect(result.journeys.map((j) => j.goal)).toEqual(["1", "2"]);
  });

  it("strips per-tool suggestedChecks — this flow does not carry them", async () => {
    mockOk({
      ok: true,
      persona: { name: "P", role: "R" },
      journeys: [
        {
          goal: "Refund the charge",
          suggestedChecks: [
            { type: "toolCalledAtLeastOnce", toolName: "refund_charge" },
          ],
        },
      ],
    });

    const result = await generateSwarmPersona(CONVEX_URL, "bearer", {
      ...personaArgs,
      journeyCount: 1,
    });
    expect(result.journeys).toEqual([{ goal: "Refund the charge" }]);
  });

  it("accepts a batch slate and clamps both counts", async () => {
    mockOk({
      ok: true,
      personas: [
        { persona: { name: "P1", role: "R1" }, journeys: [{ goal: "a" }] },
        {
          persona: { name: "P2", role: "R2" },
          journeys: [{ goal: "b" }, { goal: "c" }],
        },
        { persona: { name: "P3", role: "R3" }, journeys: [{ goal: "d" }] },
      ],
    });

    const result = await generateSwarmPersonaBatch(CONVEX_URL, "bearer", {
      ...personaArgs,
      personaCount: 2,
      journeyCount: 1,
    });
    expect(result.personas.map((entry) => entry.persona.name)).toEqual([
      "P1",
      "P2",
    ]);
    expect(result.personas[1]!.journeys.map((j) => j.goal)).toEqual(["b"]);
  });

  it("accepts a SHORT batch slate — a dropped persona is partial success", async () => {
    // The backend drops a persona whose journey slate failed rather than
    // failing the request; refusing the response here would turn every partial
    // success into an error.
    mockOk({
      ok: true,
      personas: [
        { persona: { name: "P1", role: "R1" }, journeys: [{ goal: "a" }] },
      ],
    });

    const result = await generateSwarmPersonaBatch(CONVEX_URL, "bearer", {
      ...personaArgs,
      personaCount: 6,
      journeyCount: 3,
    });
    expect(result.personas).toHaveLength(1);
  });

  it("rejects an empty or malformed batch slate", async () => {
    mockOk({ ok: true, personas: [] });
    await expect(
      generateSwarmPersonaBatch(CONVEX_URL, "bearer", {
        ...personaArgs,
        personaCount: 3,
      })
    ).rejects.toBeInstanceOf(SwarmAgentError);

    mockOk({
      ok: true,
      personas: [{ persona: { name: "P" }, journeys: [{ goal: "a" }] }],
    });
    await expect(
      generateSwarmPersonaBatch(CONVEX_URL, "bearer", {
        ...personaArgs,
        personaCount: 3,
      })
    ).rejects.toBeInstanceOf(SwarmAgentError);
  });

  it("wraps a legacy single-persona response so a stale backend still works", async () => {
    mockOk({ ok: true, persona: { name: "P", role: "R" }, journeys: [{ goal: "a" }] });

    const result = await generateSwarmPersonaBatch(CONVEX_URL, "bearer", {
      ...personaArgs,
      personaCount: 4,
    });
    expect(result.personas).toHaveLength(1);
    expect(result.personas[0]!.persona.name).toBe("P");
  });

  it("clamps over-delivery in journeys mode too", async () => {
    mockOk({ ok: true, journeys: [{ goal: "a" }, { goal: "b" }] });

    const result = await generateSwarmJourneys(CONVEX_URL, "bearer", {
      ...personaArgs,
      journeyCount: 1,
      persona: { name: "P", role: "R" },
    });
    expect(result.journeys).toHaveLength(1);
  });

  it("accepts a well-formed payload", async () => {
    mockOk({
      ok: true,
      persona: { name: "P", role: "R", notes: "n" },
      journeys: [{ name: "J", goal: "g" }, { goal: "g2" }],
    });

    const result = await generateSwarmPersona(
      CONVEX_URL,
      "bearer",
      personaArgs
    );
    expect(result.persona.name).toBe("P");
    expect(result.journeys).toHaveLength(2);
  });
});

describe("swarm-generate service — client-facing error copy", () => {
  it("keeps the deployment URL out of a 4xx with a non-JSON body", async () => {
    mockFetchOnce(403, "<html><body>Blocked by WAF</body></html>");

    const err = await generateSwarmPersona(CONVEX_URL, "bearer", {
      projectId: "proj-1",
      serverAttachmentId: "att-1",
      journeyCount: 3,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(SwarmAgentError);
    expect(err.status).toBe(403);
    expect(err.message).not.toContain(CONVEX_URL);
    expect(err.message).not.toContain("convex.site");
    expect(err.message).not.toContain("Blocked by WAF");
    expect(err.message).toContain("403");
  });

  it("keeps the deployment URL out of a 4xx with an empty body", async () => {
    mockFetchOnce(429, "");

    const err = await generateSwarmPersona(CONVEX_URL, "bearer", {
      projectId: "proj-1",
      serverAttachmentId: "att-1",
      journeyCount: 3,
    }).catch((e) => e);

    // Pin the error identity too: a bare "no convex.site" assertion would also
    // hold if the call resolved, or rejected with something unrelated.
    expect(err).toBeInstanceOf(SwarmAgentError);
    expect(err.status).toBe(429);
    expect(err.message).not.toContain("convex.site");
  });

  it("still surfaces the backend's own user-facing error copy", async () => {
    mockFetchOnce(
      429,
      JSON.stringify({ ok: false, error: "You've hit your usage limit." }),
      "application/json"
    );

    const err = await generateSwarmPersona(CONVEX_URL, "bearer", {
      projectId: "proj-1",
      serverAttachmentId: "att-1",
      journeyCount: 3,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(SwarmAgentError);
    expect(err.status).toBe(429);
    expect(err.message).toBe("You've hit your usage limit.");
    expect(err.message).not.toContain("convex.site");
  });
});
