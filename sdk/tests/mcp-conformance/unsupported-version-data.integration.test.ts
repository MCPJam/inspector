/**
 * Check 31 against real 2026-07-28 listeners: the error a server answers an
 * unsupported protocol version with has to carry `data.supported` and
 * `data.requested`, both under those names (`schema.ts:483-499`).
 *
 * The whole runner is driven over a socket, so this covers what the unit file
 * cannot: the version gate that runs before the check, the real `fetch`, and
 * the run's verdict. Each listener records the versions it was asked for and
 * the error it answered with.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MCPConformanceTest } from "../../src/mcp-conformance/index.js";
import type { MCPCheckId } from "../../src/mcp-conformance/types.js";

const CHECK: MCPCheckId = "modern-unsupported-version-error";
const SUPPORTED_VERSION = "2026-07-28";

interface Fixture {
  url: string;
  /** `MCP-Protocol-Version` of every request, in arrival order. */
  versions: Array<string | undefined>;
  /** The `data` of each `-32022` the server sent. */
  refusals: unknown[];
  close: () => Promise<void>;
}

/**
 * A 2026-07-28 server that speaks one version. Any other version gets
 * `-32022` on HTTP 400 with the `data` that `refusalData` builds from the
 * requested version.
 */
async function serve(
  refusalData: (requested: string) => unknown,
  options: {
    /** What sits in front of the server answers the probe with this page. */
    gatewayPage?: number;
    /** Answer the probe with HeaderMismatch instead of -32022. */
    headerMismatch?: boolean;
  } = {},
): Promise<Fixture> {
  const versions: Array<string | undefined> = [];
  const refusals: unknown[] = [];
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      const header = req.headers["mcp-protocol-version"];
      const version = Array.isArray(header) ? header[0] : header;
      versions.push(version);
      let message: { id?: unknown; method?: string };
      try {
        message = JSON.parse(text || "{}");
      } catch {
        res.writeHead(400).end();
        return;
      }
      const send = (status: number, payload: Record<string, unknown>) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, ...payload }));
      };
      if (version !== SUPPORTED_VERSION && options.gatewayPage) {
        res.writeHead(options.gatewayPage, {
          "content-type": "text/html; charset=utf-8",
          via: "1.1 test-gateway",
        });
        res.end("<html><body>Bad gateway</body></html>");
        return;
      }
      if (version !== SUPPORTED_VERSION && options.headerMismatch) {
        send(400, {
          error: { code: -32020, message: "Header mismatch: MCP-Protocol-Version" },
        });
        return;
      }
      if (version !== SUPPORTED_VERSION) {
        const data = refusalData(String(version));
        refusals.push(data);
        send(400, {
          error: {
            code: -32022,
            message: `Unsupported protocol version: ${version}`,
            ...(data === undefined ? {} : { data }),
          },
        });
        return;
      }
      if (message.method === "server/discover") {
        send(200, {
          result: {
            resultType: "complete",
            supportedVersions: [SUPPORTED_VERSION],
            capabilities: {},
          },
        });
        return;
      }
      send(404, { error: { code: -32601, message: "Method not found" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    versions,
    refusals,
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

async function run(fixture: Fixture) {
  opened.push(fixture);
  const result = await new MCPConformanceTest({
    serverUrl: fixture.url,
    protocolVersion: SUPPORTED_VERSION,
    checkIds: [CHECK],
    readinessIds: [],
    checkTimeout: 3_000,
    __suppressTelemetry: true,
  } as never).run();
  const check = result.checks.find((entry) => entry.id === CHECK);
  if (!check) throw new Error(`no result for ${CHECK}`);
  return { result, check };
}

describe("2026-07-28: the answer to a version the server does not speak", () => {
  it("passes when data carries supported and requested", async () => {
    const fixture = await serve((requested) => ({
      supported: [SUPPORTED_VERSION],
      requested,
    }));
    const { result, check } = await run(fixture);

    expect(check.status, check.error?.message).toBe("passed");
    expect(result.passed).toBe(true);
    // The check asked for a version no server has, once.
    expect(fixture.refusals).toEqual([
      { supported: [SUPPORTED_VERSION], requested: "1999-01-01" },
    ]);
    expect(check.details).toMatchObject({
      supportedVersions: [SUPPORTED_VERSION],
      requestedVersion: "1999-01-01",
    });
  });

  it("fails when the list is under supportedVersions", async () => {
    const fixture = await serve((requested) => ({
      supportedVersions: [SUPPORTED_VERSION],
      requested,
    }));
    const { result, check } = await run(fixture);

    // The server did send a list. Under that name a client does not find it.
    expect(fixture.refusals).toHaveLength(1);
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain(
      "this error has the list under supportedVersions, which is not the name the schema gives it",
    );
    // It is a scored check: the run fails with it.
    expect(result.passed).toBe(false);
  });

  it("fails when data.requested is missing", async () => {
    const fixture = await serve(() => ({ supported: [SUPPORTED_VERSION] }));
    const { result, check } = await run(fixture);

    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain(
      "error.data.requested must be the protocol version the client asked for, as a string",
    );
    expect(check.error?.message).not.toContain("error.data.supported");
    expect(result.passed).toBe(false);
  });

  it("fails when the error has no data", async () => {
    const fixture = await serve(() => undefined);
    const { check } = await run(fixture);

    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("error.data must be an object");
  });

  it("fails when data.requested names another version than the one asked for", async () => {
    const fixture = await serve(() => ({
      supported: [SUPPORTED_VERSION],
      requested: "2025-11-25",
    }));
    const { result, check } = await run(fixture);

    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain(
      'error.data.requested must be the version the client asked for ("1999-01-01"); this error has "2025-11-25"',
    );
    expect(result.passed).toBe(false);
  });
});

describe("2026-07-28: answers check 31 cannot judge", () => {
  it.each([502, 429])(
    "could not run when a gateway answers the probe with %i",
    async (status) => {
      const fixture = await serve(() => undefined, { gatewayPage: status });
      const { result, check } = await run(fixture);

      expect([check.status, check.skipReason]).toEqual(["skipped", "could-not-run"]);
      expect(check.error?.message).toContain("no MCP-layer response was observed");
      // Yellow, not red: the run is incomplete, not failed.
      expect(result.outcome).toBe("incomplete");
    },
  );

  it("could not run when the server answers HeaderMismatch to a probe whose versions agree", async () => {
    const fixture = await serve(() => undefined, { headerMismatch: true });
    const { check } = await run(fixture);

    expect([check.status, check.skipReason]).toEqual(["skipped", "could-not-run"]);
    expect(check.error?.message).toContain("HeaderMismatch (-32020)");
  });
});
