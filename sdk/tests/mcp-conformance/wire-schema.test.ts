import { describe, expect, it } from "vitest";
import {
  WireSchemaValidator,
  TASKS_EXTENSION_ID,
} from "../../src/mcp-conformance/wire-schema.js";
import type { ObservedWireMessage } from "../../src/mcp-conformance/wire-observations.js";

function answer(
  method: string,
  result: unknown,
  id: string | number | null = 1,
): ObservedWireMessage {
  return {
    message: { jsonrpc: "2.0", id, result },
    requestMethod: method,
    id,
    origin: `POST ${method}`,
  };
}

const MODERN = () => new WireSchemaValidator({ protocolVersion: "2026-07-28" });

/**
 * The whole point of this check is that it reproduces what the official
 * suite's `wire-schema-valid` found at 2026-07-28 and our own field checks
 * missed. These cases are those findings, not invented shapes.
 */
describe("replaying the sweep's wire-schema findings", () => {
  it("fails a tools/list result missing ttlMs and cacheScope (hubspot-shaped)", () => {
    const report = MODERN().validate([
      answer("tools/list", { resultType: "tools/list", tools: [] }),
    ]);
    expect(report.violations).toHaveLength(1);
    const errors = report.violations[0].errors.join(" ");
    expect(errors).toContain("ttlMs");
    expect(errors).toContain("cacheScope");
    expect(report.violations[0].definition).toBe("ListToolsResult");
  });

  it("fails a result missing resultType", () => {
    const report = MODERN().validate([
      answer("tools/list", { tools: [], ttlMs: 0, cacheScope: "public" }),
    ]);
    expect(report.violations[0].errors.join(" ")).toContain("resultType");
  });

  it('fails an envelope carrying "id": null (canva-shaped)', () => {
    const report = MODERN().validate([
      {
        message: { jsonrpc: "2.0", id: null, result: { resultType: "x" } },
        origin: "POST tools/list",
        id: null,
      },
    ]);
    expect(report.violations).toHaveLength(1);
    // Uncorrelated, so it is graded against the envelope union — which is
    // exactly where the `RequestId` type lives.
    expect(report.violations[0].definition).toBe("JSONRPCMessage");
  });

  it("passes a linear/notion-shaped complete result", () => {
    const report = MODERN().validate([
      answer("tools/list", {
        resultType: "tools/list",
        tools: [
          {
            name: "search",
            inputSchema: { type: "object" },
          },
        ],
        ttlMs: 60000,
        cacheScope: "private",
      }),
      answer("server/discover", {
        resultType: "server/discover",
        supportedVersions: ["2026-07-28"],
        capabilities: {},
        ttlMs: 0,
        cacheScope: "public",
      }),
    ]);
    expect(report.violations).toEqual([]);
    expect(report.correlated).toBe(2);
  });
});

describe("correlation is what makes the check non-vacuous", () => {
  it("would accept the defective result if it were NOT correlated", () => {
    // The generic union's `Result` branch allows every additional property and
    // requires only `resultType`. This is the proof that selecting
    // `ListToolsResult` by method is the load-bearing half.
    const uncorrelated: ObservedWireMessage = {
      message: {
        jsonrpc: "2.0",
        id: 1,
        result: { resultType: "tools/list", tools: [] },
      },
      id: 1,
      origin: "POST tools/list",
    };
    expect(MODERN().validate([uncorrelated]).violations).toEqual([]);
    expect(MODERN().validate([uncorrelated]).correlated).toBe(0);
  });

  it("never grades an in-band error against the method's result definition", () => {
    const report = MODERN().validate([
      {
        message: {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "no such resource" },
        },
        requestMethod: "resources/read",
        id: 1,
        origin: "POST resources/read",
      },
    ]);
    expect(report.violations).toEqual([]);
    expect(report.correlated).toBe(0);
  });

  it("grades a notification against the envelope union, not a result", () => {
    const report = MODERN().validate([
      {
        message: {
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
          params: {},
        },
        origin: "subscriptions/listen frame",
      },
    ]);
    expect(report.violations).toEqual([]);
  });
});

describe("extension awareness", () => {
  const taskResult = {
    resultType: "task",
    taskId: "task-1",
    status: "working",
    createdAt: "2026-08-21T00:00:00Z",
    lastUpdatedAt: "2026-08-21T00:00:00Z",
    ttlMs: null,
  };

  it("rejects a task-shaped tools/call result against the core schema alone", () => {
    // CORE `CallToolResult` requires `content`; this is why composing matters.
    const report = MODERN().validate([answer("tools/call", taskResult)]);
    expect(report.violations).toHaveLength(1);
  });

  it("accepts it once the tasks extension is negotiated", () => {
    const validator = new WireSchemaValidator({
      protocolVersion: "2026-07-28",
      extensionIds: [TASKS_EXTENSION_ID],
    });
    expect(validator.validate([answer("tools/call", taskResult)]).violations).toEqual(
      [],
    );
    expect(validator.extensionIds).toEqual([TASKS_EXTENSION_ID]);
  });

  it("still rejects a genuinely malformed tools/call result with tasks on", () => {
    const validator = new WireSchemaValidator({
      protocolVersion: "2026-07-28",
      extensionIds: [TASKS_EXTENSION_ID],
    });
    const report = validator.validate([
      answer("tools/call", { resultType: "task" }),
    ]);
    expect(report.violations).toHaveLength(1);
  });

  it("ignores an extension id it has no schema for", () => {
    const validator = new WireSchemaValidator({
      protocolVersion: "2026-07-28",
      extensionIds: ["io.example/not-a-thing"],
    });
    expect(validator.extensionIds).toEqual([]);
  });
});

describe("every vendored revision compiles and validates", () => {
  const VERSIONS = [
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
    "2026-07-28",
  ] as const;

  it.each(VERSIONS)("%s grades a tools/list result", (version) => {
    const validator = new WireSchemaValidator({ protocolVersion: version });
    // Every revision requires `tools` to be an array; the 2026 one requires
    // more, so the shared case is the one that must fail everywhere.
    const report = validator.validate([answer("tools/list", { tools: "nope" })]);
    expect(report.violations).toHaveLength(1);
    expect(report.protocolVersion).toBe(version);
    expect(report.schemaDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives each revision a distinct schema digest", () => {
    const digests = VERSIONS.map(
      (version) => new WireSchemaValidator({ protocolVersion: version }).schemaDigest,
    );
    expect(new Set(digests).size).toBe(VERSIONS.length);
  });

  it("changes the digest when an extension is composed in", () => {
    expect(
      new WireSchemaValidator({
        protocolVersion: "2026-07-28",
        extensionIds: [TASKS_EXTENSION_ID],
      }).schemaDigest,
    ).not.toBe(MODERN().schemaDigest);
  });
});
