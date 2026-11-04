import { afterEach, describe, expect, it, vi } from "vitest";
import { runConformance } from "../src/conformance-run.js";
import { resolveRunProtocolVersion } from "../src/conformance-run-version.js";
import { createFixtureHandler } from "./support/dual-era-fixture.js";
import type { OAuthConformanceConfig } from "../src/oauth-conformance/types.js";

const { oauth } = vi.hoisted(() => ({ oauth: vi.fn() }));
vi.mock("../src/oauth-conformance/runner.js", () => ({
  OAuthConformanceTest: class {
    constructor(private readonly config: OAuthConformanceConfig) {}
    async run() {
      oauth(this.config);
      return {
        passed: true,
        outcome: "passed",
        protocolVersion: this.config.protocolVersion,
        registrationStrategy: "dcr",
        serverUrl: this.config.serverUrl,
        steps: [],
        summary: "No auth steps",
        durationMs: 0,
      };
    }
  },
}));

interface WireEntry {
  method?: string;
  version: string | null;
  proposed?: string;
}

function legacyOnly() {
  const wire: WireEntry[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body =
      request.method === "POST" ? JSON.parse(await request.text()) : {};
    const version = request.headers.get("mcp-protocol-version");
    wire.push({
      method: body.method,
      version,
      proposed: body.params?.protocolVersion,
    });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const reply = (payload: object, status = 200) =>
      Response.json({ jsonrpc: "2.0", id: body.id, ...payload }, { status });
    if (
      body.method === "server/discover" ||
      (version && version !== "2025-06-18")
    ) {
      return reply(
        { error: { code: -32600, message: "Unsupported protocol version" } },
        400
      );
    }
    if (body.method === "initialize")
      return reply({
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "legacy-only", version: "1" },
        },
      });
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (body.method === "tools/list")
      return reply({
        result: {
          tools: [
            {
              name: "show",
              inputSchema: { type: "object" },
              _meta: { ui: { resourceUri: "ui://fixture/widget" } },
            },
          ],
        },
      });
    if (body.method === "resources/list")
      return reply({
        result: {
          resources: [
            {
              name: "widget",
              uri: "ui://fixture/widget",
              mimeType: "text/html;profile=mcp-app",
            },
          ],
        },
      });
    if (body.method === "resources/read")
      return reply({
        result: {
          contents: [
            {
              uri: "ui://fixture/widget",
              mimeType: "text/html;profile=mcp-app",
              text: "<html><body>ok</body></html>",
            },
          ],
        },
      });
    return reply({ error: { code: -32601, message: "Method not found" } });
  };
  return { wire, fetchFn };
}

const selection = {
  protocol: { checkIds: ["modern-server-discover"] as const, readinessIds: [] },
  apps: { checkIds: ["ui-resources-readable"] as const },
  tasks: { checkIds: ["tasks-wire-resolvable"] as const, readinessIds: [] },
};
function options() {
  return {
    protocol: {
      checkIds: [...selection.protocol.checkIds],
      readinessIds: [],
      checkTimeout: 2_000,
    },
    apps: { checkIds: [...selection.apps.checkIds] },
    tasks: { checkIds: [...selection.tasks.checkIds], readinessIds: [] },
  };
}

afterEach(() => vi.clearAllMocks());

describe("one HTTP revision per conformance run", () => {
  it("leaves stdio negotiation unchanged even with an empty URL field", async () => {
    await expect(
      resolveRunProtocolVersion({ server: { command: "node", url: undefined } })
    ).resolves.toBeUndefined();
  });
  it("CQT-108: a 2026 run never reads legacy resources or silently runs legacy Tasks", async () => {
    const { fetchFn, wire } = legacyOnly();
    const report = await runConformance({
      server: {
        url: "https://fixture.test/mcp",
        baseFetch: fetchFn,
        supportedProtocolVersions: ["2025-06-18"],
      },
      protocolVersion: "2026-07-28",
      ...options(),
      apps: { ...options().apps, supportedProtocolVersions: ["2025-06-18"] },
      tasks: { ...options().tasks, supportedProtocolVersions: ["2025-06-18"] },
    });
    expect(report.protocolVersion).toBe("2026-07-28");
    expect(report.reports.apps?.outcome).toBe("failed");
    expect(report.reports.tasks?.outcome).toBe("failed");
    expect(
      wire.some(
        (r) => r.method === "initialize" || r.method === "resources/read"
      )
    ).toBe(false);
    expect(wire.every((r) => r.version === "2026-07-28")).toBe(true);
  });

  it("pins a legacy run despite wider saved and per-suite accept-lists", async () => {
    const { fetchFn, wire } = legacyOnly();
    const report = await runConformance({
      server: {
        url: "https://fixture.test/mcp",
        baseFetch: fetchFn,
        supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
      },
      protocolVersion: "2025-06-18",
      suites: ["apps", "tasks"],
      ...options(),
      apps: { ...options().apps, supportedProtocolVersions: ["2025-11-25"] },
    });
    expect(report.reports.apps?.score?.protocolVersion).toBe("2025-06-18");
    expect(report.reports.tasks?.score?.protocolVersion).toBe("2025-06-18");
    expect(
      wire
        .filter((r) => r.method === "initialize")
        .every((r) => r.proposed === "2025-06-18")
    ).toBe(true);
  });

  it("negotiates Auto once, then uses that version in every suite including OAuth", async () => {
    const { fetchFn, wire } = legacyOnly();
    const report = await runConformance({
      server: { url: "https://fixture.test/mcp", baseFetch: fetchFn },
      suites: ["protocol", "apps", "tasks", "oauth"],
      ...options(),
      protocol: {
        checkIds: ["server-initialize"],
        readinessIds: [],
        checkTimeout: 2_000,
      },
      oauth: {
        serverUrl: "https://fixture.test/mcp",
        protocolVersion: "2026-07-28",
        registrationStrategy: "dcr",
      },
    });
    expect(wire.filter((r) => r.method === "server/discover")).toHaveLength(1);
    expect(report.protocolVersion).toBe("2025-06-18");
    for (const suite of Object.values(report.reports))
      expect(suite.score?.protocolVersion).toBe("2025-06-18");
    expect(oauth).toHaveBeenCalledWith(
      expect.objectContaining({ protocolVersion: "2025-06-18" })
    );
  });

  it("supports a modern Auto result and a shared server pin", async () => {
    const handler = createFixtureHandler({ apps: true });
    for (const pin of [undefined, "2026-07-28"] as const) {
      const baseFetch: typeof fetch = (input, init) =>
        handler.fetch(new Request(input, init));
      const report = await runConformance({
        server: {
          url: "https://fixture.test/mcp",
          baseFetch,
          mcpProtocolVersion: pin,
        },
        suites: ["apps", "tasks"],
        ...options(),
      });
      expect(report.reports.apps?.score?.protocolVersion).toBe("2026-07-28");
      expect(report.reports.tasks?.score?.protocolVersion).toBe("2026-07-28");
    }
  });

  it("reports unresolved Auto as incomplete and starts no suites", async () => {
    const baseFetch = vi.fn<typeof fetch>(
      async () => new Response("Unauthorized", { status: 401 })
    );
    const report = await runConformance({
      server: { url: "https://fixture.test/mcp", baseFetch },
      ...options(),
    });
    expect(report.outcome).toBe("incomplete");
    expect(report.protocolVersion).toBeUndefined();
    for (const suite of Object.values(report.reports)) {
      expect(suite.groups[0].cases[0]).toMatchObject({
        status: "skipped",
        skipReason: "could-not-run",
      });
    }
    expect(oauth).not.toHaveBeenCalled();
  });
});
