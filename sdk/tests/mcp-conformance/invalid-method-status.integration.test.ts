/**
 * Check 11 against real listeners: an unknown method on 2026-07-28 has to be
 * answered with HTTP 404 and `-32601`, not `-32601` on some other status.
 *
 * "If the server does not implement the requested RPC method, it MUST respond
 * with `404 Not Found` and a JSON-RPC error with code `-32601`" (2026-07-28
 * basic/transports/streamable-http.mdx:271-273).
 *
 * The whole runner is driven over a socket, so this covers what the unit file
 * cannot: the version gate before the check, the real `fetch`, and the status
 * as the capture reads it off the wire. Each listener records what it was
 * asked and what it answered.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MCPConformanceTest } from "../../src/mcp-conformance/index.js";

const CHECK = "protocol-invalid-method-error";
const UNKNOWN_METHOD = "nonexistent/method_that_does_not_exist";

interface Exchange {
  method: string;
  status: number;
}

interface Fixture {
  url: string;
  exchanges: Exchange[];
  close: () => Promise<void>;
}

/**
 * A server on one revision. It knows the handshake of that revision and
 * nothing else, and answers anything else with `-32601` on `unknownStatus`.
 */
async function serve(options: {
  version: "2026-07-28" | "2025-11-25";
  unknownStatus: number;
  /** Answer the unknown method with this code instead of -32601. */
  unknownCode?: number;
}): Promise<Fixture> {
  const exchanges: Exchange[] = [];
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST") {
        exchanges.push({ method: String(req.method), status: 405 });
        res.writeHead(405).end();
        return;
      }
      const message = JSON.parse(text) as { id?: unknown; method: string };
      const send = (status: number, payload?: Record<string, unknown>) => {
        exchanges.push({ method: message.method, status });
        if (!payload) {
          res.writeHead(status).end();
          return;
        }
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload }));
      };
      if (message.id === undefined) return send(202);

      const identity = {
        capabilities: {},
        serverInfo: { name: "status-fixture", version: "1.0.0" },
      };
      if (options.version === "2026-07-28" && message.method === "server/discover") {
        return send(200, {
          result: {
            resultType: "complete",
            supportedVersions: ["2026-07-28"],
            ...identity,
          },
        });
      }
      if (options.version === "2025-11-25" && message.method === "initialize") {
        return send(200, {
          result: { protocolVersion: "2025-11-25", ...identity },
        });
      }
      send(options.unknownStatus, {
        error: {
          code: options.unknownCode ?? -32601,
          message: `Method not found: ${message.method}`,
        },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    exchanges,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const opened: Fixture[] = [];

afterEach(async () => {
  for (const fixture of opened.splice(0)) await fixture.close();
});

async function run(fixture: Fixture, protocolVersion: string) {
  opened.push(fixture);
  const result = await new MCPConformanceTest({
    serverUrl: fixture.url,
    protocolVersion,
    checkIds: [CHECK],
    readinessIds: [],
    checkTimeout: 3_000,
    __suppressTelemetry: true,
  } as never).run();
  const check = result.checks.find((entry) => entry.id === CHECK);
  if (!check) throw new Error(`no result for ${CHECK}`);
  return { result, check };
}

/** What the server answered to the unknown method, as it sent it. */
function probe(fixture: Fixture): Exchange | undefined {
  return fixture.exchanges.find((entry) => entry.method === UNKNOWN_METHOD);
}

describe("2026-07-28: an unknown method", () => {
  it("passes when the server answers 404 with -32601", async () => {
    const fixture = await serve({ version: "2026-07-28", unknownStatus: 404 });
    const { result, check } = await run(fixture, "2026-07-28");

    expect(probe(fixture)).toEqual({ method: UNKNOWN_METHOD, status: 404 });
    expect(check.status).toBe("passed");
    expect(check.details).toMatchObject({ status: 404, errorCode: -32601 });
    expect(result.passed).toBe(true);
  });

  it("fails when the server answers -32601 on HTTP 200", async () => {
    const fixture = await serve({ version: "2026-07-28", unknownStatus: 200 });
    const { result, check } = await run(fixture, "2026-07-28");

    // The server did send the right code. It used to be enough.
    expect(probe(fixture)).toEqual({ method: UNKNOWN_METHOD, status: 200 });
    expect(check.status).toBe("failed");
    expect(check.error?.message).toBe(
      "Expected HTTP 404 Not Found with the -32601 error for an unrecognized method (required on 2026-07-28), got HTTP 200",
    );
    expect(check.details).toMatchObject({
      status: 200,
      expectedStatus: 404,
      error: { code: -32601 },
    });
    // It is a scored check: the run fails with it.
    expect(result.passed).toBe(false);
  });

  it("fails when the server answers -32601 on HTTP 400", async () => {
    const fixture = await serve({ version: "2026-07-28", unknownStatus: 400 });
    const { check } = await run(fixture, "2026-07-28");

    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("got HTTP 400");
  });

  it("still names the code when 404 carries another code", async () => {
    const fixture = await serve({
      version: "2026-07-28",
      unknownStatus: 404,
      unknownCode: -32600,
    });
    const { check } = await run(fixture, "2026-07-28");

    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("got -32600");
  });
});

describe("2025-11-25: an unknown method", () => {
  it("passes on HTTP 200 with -32601, which that revision allows", async () => {
    const fixture = await serve({ version: "2025-11-25", unknownStatus: 200 });
    const { check } = await run(fixture, "2025-11-25");

    expect(probe(fixture)).toEqual({ method: UNKNOWN_METHOD, status: 200 });
    expect(check.status).toBe("passed");
  });
});
