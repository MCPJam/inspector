/**
 * A server that answers 401 to a run without credentials is doing what an
 * OAuth-protected MCP server must do. Every suite reports that as
 * `incomplete` (could not run, connect and re-run), never as `failed`.
 *
 * Real HTTP servers rather than mocked fetches: the refusal has to travel the
 * same path it does against Linear or Notion — through the MCP client, which
 * raises `MCPAuthError`, and through the raw probes, which record the status.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isAuthorizationRequiredCheck } from "../src/conformance-authorization.js";
import { MCPConformanceTest } from "../src/mcp-conformance/index.js";
import { scoreFromProtocolResult } from "../src/conformance-score.js";
import { MCPAppsConformanceTest } from "../src/apps-conformance/index.js";
import {
  MCP_TASKS_CHECK_IDS,
  MCPTasksConformanceTest,
} from "../src/tasks-conformance/index.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** An endpoint that answers every request with `status` and nothing else. */
async function serveStatus(status: number): Promise<string> {
  const httpServer = http.createServer((_req, res) => {
    res
      .writeHead(status, {
        "Content-Type": "application/json",
        ...(status === 401
          ? { "WWW-Authenticate": 'Bearer realm="mcp"' }
          : {}),
      })
      .end(JSON.stringify({ error: "refused" }));
  });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const { port } = httpServer.address() as AddressInfo;
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${port}/mcp`;
}

describe("protocol conformance against a server that requires authorization", () => {
  it("reports incomplete, with every refused check marked as waiting on authorization", async () => {
    const serverUrl = await serveStatus(401);
    const result = await new MCPConformanceTest({
      serverUrl,
      checkTimeout: 5_000,
    }).run();

    expect(result.outcome).toBe("incomplete");
    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => check.status === "failed")).toEqual(
      [],
    );

    const initialize = result.checks.find(
      (check) => check.id === "server-initialize",
    );
    expect(initialize).toMatchObject({
      status: "skipped",
      skipReason: "could-not-run",
    });
    expect(initialize?.error?.message).toMatch(/requires authorization/);
    expect(isAuthorizationRequiredCheck(initialize!)).toBe(true);
    expect(result.incompleteReason).toMatch(/requires authorization/);
  }, 60_000);

  it("treats the era as unknown on an unpinned refused run: every selected check could not run, none is era-skipped", async () => {
    const serverUrl = await serveStatus(401);
    // The default selection mixes client-backed and raw checks of both eras.
    const result = await new MCPConformanceTest({
      serverUrl,
      checkTimeout: 5_000,
    }).run();

    expect(result.checks.length).toBeGreaterThan(0);
    for (const check of result.checks) {
      expect(check, check.id).toMatchObject({
        status: "skipped",
        skipReason: "could-not-run",
      });
      expect(isAuthorizationRequiredCheck(check), check.id).toBe(true);
    }
    // Both eras are represented, and neither was judged against a guessed one.
    const ids = result.checks.map((check) => check.id);
    expect(ids).toContain("server-initialize");
    expect(ids).toContain("modern-client-handshake");
    expect(ids).toContain("protocol-invalid-method-error");

    const score = scoreFromProtocolResult(result);
    expect(score.outcome).toBe("incomplete");
    expect(score.notApplicable).toBe(0);
    expect(score.passed).toBe(0);
    expect(score.failed).toBe(0);
    expect(score.couldNotRun).toBe(score.applicable);
  }, 60_000);

  it("does not era-skip a client-only unpinned selection either", async () => {
    const serverUrl = await serveStatus(401);
    const result = await new MCPConformanceTest({
      serverUrl,
      checkIds: ["server-initialize", "modern-client-handshake"],
      checkTimeout: 5_000,
    }).run();

    expect(
      result.checks.map((check) => [check.id, check.skipReason]),
    ).toEqual([
      ["server-initialize", "could-not-run"],
      ["modern-client-handshake", "could-not-run"],
    ]);
    expect(result.outcome).toBe("incomplete");
  }, 60_000);

  it("keeps era gating on a pinned refused run and still runs its raw probes", async () => {
    const serverUrl = await serveStatus(401);
    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: "2025-11-25",
      checkIds: [
        "server-initialize",
        "modern-client-handshake",
        "protocol-invalid-method-error",
      ],
      checkTimeout: 5_000,
    }).run();

    const byId = Object.fromEntries(
      result.checks.map((check) => [check.id, check]),
    );
    // The pin names the era, so the other era's check does not apply.
    expect(byId["modern-client-handshake"]).toMatchObject({
      status: "skipped",
      skipReason: "not-applicable",
    });
    expect(byId["server-initialize"]).toMatchObject({
      skipReason: "could-not-run",
    });
    // The raw probe ran, saw the 401, and was reclassified rather than skipped.
    expect(byId["protocol-invalid-method-error"]).toMatchObject({
      skipReason: "could-not-run",
      details: expect.objectContaining({
        status: 401,
        probeFailure: expect.any(String),
      }),
    });

    const score = scoreFromProtocolResult(result);
    expect(score.outcome).toBe("incomplete");
    expect(score.notApplicable).toBe(1);
    expect(score.couldNotRun).toBe(2);
  }, 60_000);

  it("reclassifies a raw probe that only saw the 401, keeping its original message", async () => {
    const serverUrl = await serveStatus(401);
    const result = await new MCPConformanceTest({
      serverUrl,
      // A pin lets the raw runners skip the client connection, so this is the
      // probe path on its own.
      protocolVersion: "2025-11-25",
      checkIds: ["protocol-invalid-method-error"],
      checkTimeout: 5_000,
    }).run();

    const [probe] = result.checks;
    expect(probe).toMatchObject({
      id: "protocol-invalid-method-error",
      status: "skipped",
      skipReason: "could-not-run",
    });
    expect(isAuthorizationRequiredCheck(probe!)).toBe(true);
    expect(probe?.details).toMatchObject({
      status: 401,
      probeFailure: expect.any(String),
    });
    expect(result.outcome).toBe("incomplete");
  }, 60_000);

  it("reports an unpinned raw-only run incomplete instead of rejecting it", async () => {
    const serverUrl = await serveStatus(401);
    // No pin: the runner connects only to learn the era, and that connection
    // is the one refused.
    const result = await new MCPConformanceTest({
      serverUrl,
      checkIds: ["protocol-invalid-method-error"],
      checkTimeout: 5_000,
    }).run();

    expect(result.outcome).toBe("incomplete");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      id: "protocol-invalid-method-error",
      category: "protocol",
      status: "skipped",
      skipReason: "could-not-run",
    });
    expect(isAuthorizationRequiredCheck(result.checks[0]!)).toBe(true);
  }, 60_000);

  it("still fails a server that answers 403: authenticated but forbidden is not a missing credential", async () => {
    const serverUrl = await serveStatus(403);
    const result = await new MCPConformanceTest({
      serverUrl,
      checkIds: ["server-initialize"],
      checkTimeout: 5_000,
    }).run();

    expect(result.outcome).toBe("failed");
    expect(
      result.checks.some((check) => isAuthorizationRequiredCheck(check)),
    ).toBe(false);
  }, 60_000);

  it("still fails a server that refuses the connection for any other reason", async () => {
    const serverUrl = await serveStatus(500);
    const result = await new MCPConformanceTest({
      serverUrl,
      checkIds: ["server-initialize"],
      checkTimeout: 5_000,
    }).run();

    expect(result.outcome).toBe("failed");
    expect(
      result.checks.some((check) => isAuthorizationRequiredCheck(check)),
    ).toBe(false);
  }, 60_000);
});

describe("apps and tasks conformance against a server that requires authorization", () => {
  it("reports the apps suite incomplete, not failed", async () => {
    const url = await serveStatus(401);
    const result = await new MCPAppsConformanceTest({
      url,
      timeout: 5_000,
    }).run();

    expect(result.outcome).toBe("incomplete");
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every(isAuthorizationRequiredCheck)).toBe(true);
  }, 60_000);

  it("reports the tasks suite incomplete, not failed", async () => {
    const url = await serveStatus(401);
    const result = await new MCPTasksConformanceTest({
      url,
      timeout: 5_000,
    } as never).run();

    expect(result.outcome).toBe("incomplete");
    expect(result.passed).toBe(false);
    // Every selected check is reported, not one stand-in.
    expect(result.checks.map((check) => check.id)).toEqual([
      ...MCP_TASKS_CHECK_IDS,
    ]);
    expect(result.checks.every(isAuthorizationRequiredCheck)).toBe(true);
  }, 60_000);

  it("reports exactly the selected task checks when the run narrows them", async () => {
    const url = await serveStatus(401);
    const result = await new MCPTasksConformanceTest({
      url,
      timeout: 5_000,
      checkIds: ["tasks-inline-result"],
    } as never).run();

    expect(result.outcome).toBe("incomplete");
    expect(result.checks.map((check) => check.id)).toEqual([
      "tasks-inline-result",
    ]);
  }, 60_000);
});
