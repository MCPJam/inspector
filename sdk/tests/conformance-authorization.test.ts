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
import { MCPAppsConformanceTest } from "../src/apps-conformance/index.js";
import { MCPTasksConformanceTest } from "../src/tasks-conformance/index.js";

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
    expect(result.checks).toHaveLength(1);
    expect(isAuthorizationRequiredCheck(result.checks[0]!)).toBe(true);
  }, 60_000);
});
