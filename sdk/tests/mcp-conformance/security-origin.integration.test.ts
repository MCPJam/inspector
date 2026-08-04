/**
 * Version sensitivity of `localhost-host-rebinding-rejected`.
 *
 * 2025-03-26 and 2025-06-18 state the Origin-validation MUST but name no
 * status, so any 4xx rejection satisfies them. 2025-11-25 added (changelog PR
 * #1439): "If the Origin header is present and invalid, servers MUST respond
 * with HTTP 403 Forbidden." The same 400-rejecting server therefore passes
 * under a 2025-06-18 pin and fails under a 2025-11-25 pin.
 *
 * A real listener is required: the security probes forge the Host header via
 * `node:http`, which `fetch` forbids, so there is no fetchFn to stub.
 */

import http from "node:http";
import { runSecurityChecks } from "../../src/mcp-conformance/checks/security.js";
import type { MCPCheckId } from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";

async function serveStatus(
  status: number,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? "";
    const origin = req.headers.origin ?? "";
    // Keyed on the ORIGIN as well as the Host: the requirement under test is
    // about a present-and-invalid `Origin`, so a fixture that rejected on Host
    // alone would stay green even if the probe stopped sending Origin at all.
    if (host.includes("evil.example.com") && origin === "http://evil.example.com") {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rejected" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Server did not bind to a port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const SELECTED = new Set<MCPCheckId>(["localhost-host-rebinding-rejected"]);

describe("Origin rejection status by protocol version", () => {
  it("accepts any 4xx under a 2025-06-18 pin", async () => {
    const server = await serveStatus(400);
    try {
      const config = normalizeMCPConformanceConfig({
        serverUrl: server.url,
        protocolVersion: "2025-06-18",
        checkTimeout: 3_000,
      });
      const results = await runSecurityChecks(
        { config, serverUrl: server.url, fetchFn: config.fetchFn },
        SELECTED,
      );
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("passed");
    } finally {
      await server.stop();
    }
  });

  it("requires exactly 403 under a 2025-11-25 pin", async () => {
    const server = await serveStatus(400);
    try {
      const config = normalizeMCPConformanceConfig({
        serverUrl: server.url,
        protocolVersion: "2025-11-25",
        checkTimeout: 3_000,
      });
      const results = await runSecurityChecks(
        { config, serverUrl: server.url, fetchFn: config.fetchFn },
        SELECTED,
      );
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("failed");
      expect(results[0].error?.message).toMatch(/403 Forbidden/);
    } finally {
      await server.stop();
    }
  });

  it("accepts any 4xx when the run pinned no version at all", async () => {
    // The resolved version falls back to 2025-11-25 so the probe has something
    // to put on the wire, but an unpinned run asserted nothing about which
    // revision it judges — demanding 403 from it would newly fail servers that
    // passed before the requirement was sharpened.
    const server = await serveStatus(400);
    try {
      const config = normalizeMCPConformanceConfig({
        serverUrl: server.url,
        checkTimeout: 3_000,
      });
      expect(config.protocolVersion).toBeUndefined();
      const results = await runSecurityChecks(
        { config, serverUrl: server.url, fetchFn: config.fetchFn },
        SELECTED,
      );
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("passed");
    } finally {
      await server.stop();
    }
  });

  it("passes a 403-rejecting server under a 2025-11-25 pin", async () => {
    const server = await serveStatus(403);
    try {
      const config = normalizeMCPConformanceConfig({
        serverUrl: server.url,
        protocolVersion: "2025-11-25",
        checkTimeout: 3_000,
      });
      const results = await runSecurityChecks(
        { config, serverUrl: server.url, fetchFn: config.fetchFn },
        SELECTED,
      );
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("passed");
    } finally {
      await server.stop();
    }
  });
});
