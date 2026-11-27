/**
 * Modern Client Handshake against real 2026-07-28 listeners that do, or do
 * not, say who they are.
 *
 * `io.modelcontextprotocol/serverInfo` is a SHOULD and an optional field
 * (2026-07-28 basic/index.mdx:397-403, schema.ts:157). A server that leaves
 * it out used to fail the handshake check, and with it the whole run.
 *
 * The whole runner is driven over a socket with the real MCP client, so this
 * covers what the unit file cannot: what the client makes of a result with no
 * identity, the run's verdict, and the advice that takes the check's place.
 * A server built on the official SDK always stamps its identity, so these
 * listeners are hand-built.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MCPConformanceTest } from "../../src/mcp-conformance/index.js";
import type { MCPCheckId } from "../../src/mcp-conformance/types.js";

const HANDSHAKE: MCPCheckId = "modern-client-handshake";
const DISCOVER: MCPCheckId = "modern-server-discover";
const ADVICE = "readiness-server-identity";
const META_KEY = "io.modelcontextprotocol/serverInfo";

interface Fixture {
  url: string;
  /** JSON-RPC methods in arrival order. */
  methods: string[];
  close: () => Promise<void>;
}

/**
 * A 2026-07-28 server with nothing but `server/discover`. `identity` is what
 * it stamps under `_meta`; `undefined` stamps nothing.
 */
async function serve(identity: unknown): Promise<Fixture> {
  const methods: string[] = [];
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      const send = (status: number, payload: Record<string, unknown>) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", ...payload }));
      };
      let message: { id?: unknown; method?: string };
      try {
        message = JSON.parse(text || "{}");
      } catch {
        send(400, { id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      methods.push(message.method ?? String(req.method));
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (message.method !== "server/discover") {
        send(404, {
          id: message.id ?? null,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        });
        return;
      }
      send(200, {
        id: message.id,
        result: {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: {},
          ...(identity === undefined ? {} : { _meta: { [META_KEY]: identity } }),
        },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    methods,
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

async function run(
  fixture: Fixture,
  options: { checkIds?: MCPCheckId[]; advice?: boolean } = {},
) {
  opened.push(fixture);
  return await new MCPConformanceTest({
    serverUrl: fixture.url,
    protocolVersion: "2026-07-28",
    checkIds: options.checkIds ?? [HANDSHAKE],
    readinessIds: options.advice === false ? [] : [ADVICE],
    checkTimeout: 5_000,
    __suppressTelemetry: true,
  } as never).run();
}

const byId = (
  result: Awaited<ReturnType<typeof run>>,
  id: MCPCheckId,
) => {
  const check = result.checks.find((entry) => entry.id === id);
  if (!check) throw new Error(`no result for ${id}`);
  return check;
};

const adviceWarnings = (result: Awaited<ReturnType<typeof run>>) =>
  result.readiness.filter((entry) => entry.id === ADVICE);

const adviceMet = (result: Awaited<ReturnType<typeof run>>) =>
  (result.passedAdvice ?? []).some((entry) => entry.id === ADVICE);

describe("a 2026-07-28 server that sends no serverInfo", () => {
  it("passes the handshake check, and the run with it", async () => {
    const result = await run(await serve(undefined));

    const handshake = byId(result, HANDSHAKE);
    expect(handshake.status, handshake.error?.message).toBe("passed");
    // The silent server stays visible in the report.
    expect(handshake.details).toMatchObject({
      protocolVersion: "2026-07-28",
      serverVersion: null,
    });
    expect(result.outcome).toBe("passed");
    expect(result.passed).toBe(true);
  });

  it("is told, as SHOULD advice, that it did not say who it is", async () => {
    const result = await run(await serve(undefined));

    expect(adviceWarnings(result)).toEqual([
      expect.objectContaining({
        id: ADVICE,
        title: "Server Identity",
        severity: "warning",
        specStrength: "SHOULD",
        message: expect.stringContaining(`has no ${META_KEY} in _meta`),
      }),
    ]);
    expect(adviceMet(result)).toBe(false);
  });

  it("passes Server Discover too, as it did", async () => {
    const result = await run(await serve(undefined), {
      checkIds: [HANDSHAKE, DISCOVER],
    });

    expect(byId(result, DISCOVER).status).toBe("passed");
    expect(result.passed).toBe(true);
  });
});

describe("a 2026-07-28 server that names itself", () => {
  it("passes the handshake check and meets the advice", async () => {
    const result = await run(
      await serve({ name: "typed-fixture", version: "1.0.0" }),
    );

    const handshake = byId(result, HANDSHAKE);
    expect(handshake.status).toBe("passed");
    expect(handshake.details?.serverVersion).toMatchObject({
      name: "typed-fixture",
      version: "1.0.0",
    });
    expect(adviceWarnings(result)).toEqual([]);
    expect(adviceMet(result)).toBe(true);
  });
});

describe("a 2026-07-28 server whose serverInfo is malformed", () => {
  const malformedIdentities = [{ name: 5 }, null, "Hello MCP"];

  it.each(malformedIdentities)("fails Server Discover for %j", async (identity) => {
    const result = await run(await serve(identity), {
      checkIds: [HANDSHAKE, DISCOVER],
    });

    const discover = byId(result, DISCOVER);
    expect(discover.status).toBe("failed");
    expect(discover.error?.message).toContain(
      `${META_KEY} must carry a string name and a string version`,
    );
    // The handshake itself completed, so its check has nothing against it,
    // and the advice does not report the same defect a second time.
    expect(byId(result, HANDSHAKE).status).toBe("passed");
    expect(adviceWarnings(result)).toEqual([]);
    expect(adviceMet(result)).toBe(false);
    expect(result.passed).toBe(false);
  });
});

describe("the advice left out of a run", () => {
  it("sends no server/discover of its own", async () => {
    const withAdvice = await serve(undefined);
    await run(withAdvice);
    const without = await serve(undefined);
    const result = await run(without, { advice: false });

    const discovers = (fixture: Fixture) =>
      fixture.methods.filter((method) => method === "server/discover").length;
    expect(discovers(withAdvice) - discovers(without)).toBe(1);
    expect(result.readiness).toEqual([]);
    expect(byId(result, HANDSHAKE).status).toBe("passed");
  });
});
