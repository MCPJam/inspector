/**
 * The client-signature probe (E26, R8, RP9): discovery GETs only, one per
 * signature for each document discovery found, one at a time, with no
 * credentials; a refusal keeps its status and the first 2,000 characters of
 * its body.
 */

import { describe, expect, it } from "vitest";

import { probeDirectoryClientSignatures } from "../../src/directory-readiness/reviewer/client-signatures.js";
import { DIRECTORY_CLIENT_SIGNATURES } from "../../src/directory-readiness/reviewer/evidence.js";

const PRM =
  "https://connector.example.com/.well-known/oauth-protected-resource/mcp";
const AS = "https://auth.example.com/.well-known/oauth-authorization-server";
const REFUSAL = `error code: 1010 ${"x".repeat(3000)}`;

function edge(refuse: (userAgent: string | null, url: string) => boolean) {
  const requests: Array<{ url: string; method?: string; headers: Headers }> =
    [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({ url, method: init?.method, headers });
    return refuse(headers.get("user-agent"), url)
      ? new Response(REFUSAL, { status: 403 })
      : new Response(
          JSON.stringify({ resource: "https://connector.example.com/mcp" })
        );
  }) as typeof fetch;
  return { requests, fetchFn };
}

describe("the client-signature probe", () => {
  it("requests each document once per signature, with no credentials and no other method", async () => {
    const { requests, fetchFn } = edge(() => false);
    const evidence = await probeDirectoryClientSignatures({
      documents: { "protected-resource": PRM, "authorization-server": AS },
      fetchFn,
    });
    expect(requests).toHaveLength(DIRECTORY_CLIENT_SIGNATURES.length * 2);
    expect(requests.map((entry) => entry.url)).toEqual([
      PRM,
      PRM,
      PRM,
      AS,
      AS,
      AS,
    ]);
    for (const { method, headers } of requests) {
      expect(method ?? "GET").toBe("GET");
      expect(headers.get("authorization")).toBeNull();
    }
    // MCPJam's own client sends what the run's transport always sends.
    expect(requests.map((entry) => entry.headers.get("user-agent"))).toEqual([
      null,
      expect.stringContaining("Mozilla/5.0"),
      "Python-urllib/3.12",
      null,
      expect.stringContaining("Mozilla/5.0"),
      "Python-urllib/3.12",
    ]);
    expect(evidence.probes.every((probe) => probe.status === 200)).toBe(true);
    expect(evidence.probes.some((probe) => "body" in probe)).toBe(false);
  });

  it("keeps a refusal's status and the first 2,000 characters of its body", async () => {
    const { fetchFn } = edge(
      (userAgent) => userAgent?.startsWith("Python") ?? false
    );
    const evidence = await probeDirectoryClientSignatures({
      documents: { "protected-resource": PRM },
      fetchFn,
    });
    const refused = evidence.probes.filter((probe) => probe.status === 403);
    expect(refused).toEqual([
      {
        signature: "http-library",
        document: "protected-resource",
        url: PRM,
        status: 403,
        body: REFUSAL.slice(0, 2000),
      },
    ]);
  });

  it("records a request nothing answered, and sends nothing for a document discovery did not find", async () => {
    const fetchFn = (async () => {
      throw new Error("connect ECONNRESET");
    }) as typeof fetch;
    const evidence = await probeDirectoryClientSignatures({
      documents: { "authorization-server": AS },
      fetchFn,
    });
    expect(evidence.probes).toHaveLength(3);
    expect(evidence.probes[0]).toMatchObject({
      status: 0,
      body: "connect ECONNRESET",
    });
    expect(
      await probeDirectoryClientSignatures({ documents: {}, fetchFn })
    ).toEqual({ probes: [] });
  });

  it("stops when the run is cancelled", async () => {
    const controller = new AbortController();
    const { requests, fetchFn } = edge(() => {
      controller.abort(new Error("cancelled"));
      return false;
    });
    await expect(
      probeDirectoryClientSignatures({
        documents: { "protected-resource": PRM, "authorization-server": AS },
        fetchFn,
        signal: controller.signal,
      })
    ).rejects.toThrow("cancelled");
    expect(requests).toHaveLength(1);
  });
});
