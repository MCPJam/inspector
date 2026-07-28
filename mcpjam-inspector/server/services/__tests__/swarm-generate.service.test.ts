/**
 * The generation service's error message is forwarded VERBATIM to the browser
 * by the web route on any 4xx, so it must never carry transport detail — in
 * particular the Convex deployment URL from CONVEX_HTTP_URL.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { generateSwarmPersona } from "../swarm-generate.js";
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
