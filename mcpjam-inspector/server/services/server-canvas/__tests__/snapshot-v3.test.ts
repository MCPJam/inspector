import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_JSON_FIELD_MAX_BYTES,
  type CapturedEventsCapability,
  type ConnectedServerDoctorState,
} from "@mcpjam/sdk";
import {
  buildSnapshotServerV3,
  fidelityJson,
  hasReservedKeys,
} from "../snapshot-v3.js";
import { SNAPSHOT_SERVER_MAX_BYTES } from "../snapshot-budget.js";

const ok = (detail = "ok") => ({ status: "ok" as const, detail });

function doctorState(
  overrides: Partial<ConnectedServerDoctorState> = {},
): ConnectedServerDoctorState {
  return {
    initInfo: {
      protocolVersion: "2025-11-25",
      transport: "streamable-http",
      serverVersion: {
        name: "fixture",
        title: "Fixture Server",
        version: "1.2.0",
        websiteUrl: "https://fixture.example.test",
        icons: [
          { src: "https://fixture.example.test/icon.png", mimeType: "image/png", sizes: ["48x48"] },
          { src: 42 },
        ],
      },
      serverCapabilities: { tools: { listChanged: true } },
      instructions: "  Call search first.  ",
      clientCapabilities: { extensions: { "io.modelcontextprotocol/ui": {} } },
    },
    capabilities: { tools: { listChanged: true } },
    tools: [
      {
        name: "zeta",
        title: "Zeta",
        description: "Last tool.",
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { q: { type: "string" } },
        },
        annotations: { title: "Zeta tool", readOnlyHint: true, vendor: "x" },
        execution: { taskSupport: "optional" },
        icons: [{ src: "https://fixture.example.test/zeta.svg", theme: "dark" }],
      },
      { name: "alpha", inputSchema: { type: "object" } },
    ],
    toolsMetadata: {
      zeta: { ui: { resourceUri: "ui://zeta" }, $internal: 1 },
    },
    resources: [
      {
        uri: "ui://zeta",
        name: "zeta-ui",
        mimeType: "text/html;profile=mcp-app",
        _meta: { ui: { csp: {} } },
        annotations: { audience: ["user"] },
      },
    ],
    resourceTemplates: [{ uriTemplate: "file:///{path}", name: "file" }],
    prompts: [
      {
        name: "summarize",
        arguments: [{ name: "text", required: true }, { bad: true }],
      },
    ],
    skills: [
      { name: "review", description: "Reviews code.", skillUri: "skill://review/SKILL.md" },
    ],
    checks: {
      initialization: ok(),
      capabilities: ok(),
      tools: ok(),
      resources: ok(),
      resourceTemplates: ok(),
      prompts: ok(),
      skills: ok(),
    },
    errors: [],
    ...overrides,
  };
}

const handshake: CapturedEventsCapability = {
  source: "initialize",
  events: undefined,
  listChanged: false,
  rawCapabilities: {
    tools: { listChanged: true },
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] } },
    experimental: { "vendor.feature": { $ref: "#/x" } },
    events: {},
  },
  protocolVersion: "2025-11-25",
  supportedVersions: ["2025-11-25", "2026-07-28"],
  rawMeta: { "io.example/build": "abc" },
  observedAt: 1,
};

describe("buildSnapshotServerV3", () => {
  it("keeps titles, icons, annotation titles and full discovery", () => {
    const server = buildSnapshotServerV3({
      serverId: "srv_1",
      state: doctorState(),
      handshake,
      skillsSupport: { declared: true, advertised: true },
    });

    expect(server.tools.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
    const zeta = server.tools[1];
    expect(zeta).toMatchObject({
      title: "Zeta",
      description: "Last tool.",
      icons: [{ src: "https://fixture.example.test/zeta.svg", theme: "dark" }],
      annotations: { title: "Zeta tool", readOnlyHint: true },
      execution: { taskSupport: "optional" },
    });
    expect(zeta.annotations).not.toHaveProperty("vendor");
    expect(server.discovery).toEqual({
      protocolVersion: "2025-11-25",
      supportedVersions: ["2025-11-25", "2026-07-28"],
      serverInfo: {
        name: "fixture",
        title: "Fixture Server",
        version: "1.2.0",
        websiteUrl: "https://fixture.example.test",
        icons: [
          {
            src: "https://fixture.example.test/icon.png",
            mimeType: "image/png",
            sizes: ["48x48"],
          },
        ],
      },
      capabilities: {
        tools: { listChanged: true },
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] } },
        experimental: { "vendor.feature": {} },
        events: {},
      },
      capabilitiesJson: JSON.stringify(handshake.rawCapabilities),
      instructions: "Call search first.",
      meta: { "io.example/build": "abc" },
      metaJson: JSON.stringify(handshake.rawMeta),
    });
    expect(server.transport).toBe("streamable-http");
    expect(server.skills).toEqual([
      { name: "review", description: "Reviews code.", uri: "skill://review/SKILL.md" },
    ]);
    expect(server.prompts).toEqual([
      { name: "summarize", arguments: [{ name: "text", required: true }] },
    ]);
  });

  it("writes fidelity strings for schemas and _meta that stripping would change", () => {
    const server = buildSnapshotServerV3({
      serverId: "srv_1",
      state: doctorState(),
      handshake,
    });
    const [alpha, zeta] = server.tools;

    expect(zeta.inputSchema).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
    expect(JSON.parse(zeta.inputSchemaJson ?? "null")).toHaveProperty("$schema");
    expect(zeta.meta).toEqual({ ui: { resourceUri: "ui://zeta" } });
    expect(JSON.parse(zeta.metaJson ?? "null")).toEqual({
      ui: { resourceUri: "ui://zeta" },
      $internal: 1,
    });
    // Nothing to preserve: no fidelity string.
    expect(alpha).not.toHaveProperty("inputSchemaJson");
    expect(alpha).not.toHaveProperty("metaJson");
    expect(server.resources?.[0]).toMatchObject({
      uri: "ui://zeta",
      meta: { ui: { csp: {} } },
      metaJson: JSON.stringify({ ui: { csp: {} } }),
      annotations: { audience: ["user"] },
    });
    expect(server.coverage).toMatchObject({
      tools: "complete",
      toolMeta: "complete",
      toolSchemas: "complete",
      capabilities: "complete",
      serverInfo: "complete",
      instructions: "complete",
      listHints: "not-captured",
    });
  });

  it("omits oversized fidelity strings and marks their coverage partial", () => {
    const huge = "x".repeat(SNAPSHOT_JSON_FIELD_MAX_BYTES);
    const server = buildSnapshotServerV3({
      serverId: "srv_1",
      state: doctorState({
        tools: [
          {
            name: "big",
            inputSchema: { $defs: { blob: { description: huge } } },
          },
        ],
        toolsMetadata: { big: { note: huge } },
      }),
      handshake,
    });

    expect(server.tools[0]).not.toHaveProperty("inputSchemaJson");
    expect(server.tools[0]).not.toHaveProperty("metaJson");
    expect(server.tools[0].meta).toEqual({ note: huge });
    expect(server.coverage).toMatchObject({
      toolSchemas: "partial",
      toolMeta: "partial",
    });
  });

  it("keeps http(s) icons without credentials and image data URIs only", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const svg = "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E";
    const icons = [
      { src: "https://cdn.example.test/a.png" },
      { src: "http://cdn.example.test/b.png" },
      { src: png },
      { src: svg },
      { src: "https://user:secret@cdn.example.test/c.png" },
      { src: "javascript:alert(1)" },
      { src: "data:text/html;base64,PHNjcmlwdD4=" },
      { src: "ftp://cdn.example.test/d.png" },
      { src: "data:image/png;base64,with space" },
      { src: `data:image/png;base64,${"A".repeat(4096)}` },
      { src: `https://cdn.example.test/${"e".repeat(1100)}.png` },
    ];
    const server = buildSnapshotServerV3({
      serverId: "srv_1",
      state: doctorState({
        initInfo: { protocolVersion: "2025-11-25", serverVersion: { name: "fixture", icons } },
        tools: [{ name: "iconic", icons }],
      }),
    });

    const kept = ["https://cdn.example.test/a.png", "http://cdn.example.test/b.png", png, svg];
    expect(server.tools[0]?.icons?.map((icon) => icon.src)).toEqual(kept);
    expect(server.discovery?.serverInfo?.icons?.map((icon) => icon.src)).toEqual(kept);
  });

  it("marks failed lists not captured and records a failed tool list as the capture error", () => {
    const failed = { status: "error" as const, detail: "tools/list timed out" };
    const server = buildSnapshotServerV3({
      serverId: "srv_1",
      state: doctorState({
        tools: [],
        resources: [],
        checks: {
          ...doctorState().checks,
          tools: failed,
          resources: { status: "error", detail: "boom" },
          resourceTemplates: { status: "skipped", detail: "unsupported" },
          skills: { status: "skipped", detail: "not declared" },
        },
      }),
      skillsSupport: { declared: false, advertised: true },
    });

    expect(server.captureError).toBe("tools/list timed out");
    expect(server.coverage).toMatchObject({
      tools: "not-captured",
      toolMeta: "not-captured",
      toolSchemas: "not-captured",
      resources: "not-captured",
      resourceTemplates: "complete",
      skills: "complete",
      // Without the raw handshake, parsed capabilities may have lost keys.
      capabilities: "partial",
    });
  });

  it("leaves skills not captured when MCPJam did not advertise the extension", () => {
    const server = buildSnapshotServerV3({
      serverId: "srv_1",
      state: doctorState({
        checks: {
          ...doctorState().checks,
          skills: { status: "skipped", detail: "pinned client" },
        },
      }),
      skillsSupport: { declared: true, advertised: false },
    });
    expect(server.coverage?.skills).toBe("not-captured");
  });
});

describe("snapshot budget", () => {
  const bytes = (value: unknown) =>
    Buffer.byteLength(JSON.stringify(value), "utf8");
  const description = "d".repeat(150);

  /** A schema whose `$defs` stripping removes, so it also travels as JSON. */
  function defsSchema() {
    const names = Array.from({ length: 40 }, (_, index) => `f${index}`);
    return {
      type: "object",
      properties: Object.fromEntries(
        names.map((name) => [name, { $ref: `#/$defs/${name}`, description }]),
      ),
      $defs: Object.fromEntries(
        names.map((name) => [name, { type: "string", description }]),
      ),
    };
  }

  it("gives up schema JSON strings first when many tools carry large $defs schemas", () => {
    expect(fidelityJson(defsSchema())).not.toBe("oversize");
    const tools = Array.from({ length: 80 }, (_, index) => ({
      name: `tool_${String(index).padStart(2, "0")}`,
      inputSchema: defsSchema(),
    }));
    const server = buildSnapshotServerV3({
      serverId: "srv_1",
      state: doctorState({ tools, toolsMetadata: {} }),
      handshake,
    });

    expect(bytes(server)).toBeLessThanOrEqual(SNAPSHOT_SERVER_MAX_BYTES);
    expect(server.tools).toHaveLength(80);
    // The stripped schemas stay; only some of their JSON copies are dropped.
    expect(server.tools.every((tool) => tool.inputSchema !== undefined)).toBe(true);
    const kept = server.tools.filter((tool) => tool.inputSchemaJson).length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(80);
    expect(server.coverage).toMatchObject({
      toolSchemas: "partial",
      toolMeta: "complete",
      tools: "complete",
    });
    // Discovery evidence is smaller than any schema, so it is kept.
    expect(server.discovery?.capabilitiesJson).toBeDefined();
  });

  it("gives up meta objects after every JSON string, and marks tool meta partial", () => {
    const toolsMetadata: Record<string, Record<string, unknown>> = {};
    const tools = Array.from({ length: 100 }, (_, index) => {
      const name = `tool_${String(index).padStart(3, "0")}`;
      toolsMetadata[name] = { note: "m".repeat(12_000), _vendor: 1 };
      return { name, inputSchema: { type: "object" } };
    });

    const server = buildSnapshotServerV3({
      serverId: "srv_1",
      state: doctorState({ tools, toolsMetadata }),
      handshake,
    });

    expect(bytes(server)).toBeLessThanOrEqual(SNAPSHOT_SERVER_MAX_BYTES);
    expect(server.tools.some((tool) => tool.metaJson)).toBe(false);
    const withMeta = server.tools.filter((tool) => tool.meta).length;
    expect(withMeta).toBeGreaterThan(0);
    expect(withMeta).toBeLessThan(100);
    expect(server.tools.every((tool) => tool.inputSchema)).toBe(true);
    expect(server.coverage).toMatchObject({
      toolMeta: "partial",
      toolSchemas: "complete",
    });
  });

  it("leaves a part that was not captured as it is", () => {
    const tools = Array.from({ length: 80 }, (_, index) => ({
      name: `tool_${index}`,
      inputSchema: defsSchema(),
    }));
    const server = buildSnapshotServerV3({
      serverId: "srv_1",
      state: doctorState({
        tools,
        toolsMetadata: {},
        checks: {
          ...doctorState().checks,
          tools: { status: "error", detail: "tools/list ended early" },
        },
      }),
      handshake,
    });
    expect(bytes(server)).toBeLessThanOrEqual(SNAPSHOT_SERVER_MAX_BYTES);
    expect(server.coverage?.toolSchemas).toBe("not-captured");
  });
});

describe("fidelity helpers", () => {
  it("finds reserved keys at any depth", () => {
    expect(hasReservedKeys({ a: [{ b: { _c: 1 } }] })).toBe(true);
    expect(hasReservedKeys({ a: [{ b: { c: "$x" } }] })).toBe(false);
  });

  it("bounds JSON by bytes", () => {
    expect(fidelityJson({ a: 1 })).toBe('{"a":1}');
    expect(fidelityJson("é".repeat(SNAPSHOT_JSON_FIELD_MAX_BYTES))).toBe(
      "oversize",
    );
  });
});
