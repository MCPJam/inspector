import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  MCPConformanceTest,
  type MCPCheckId,
  type MCPCheckResult,
} from "../../src/mcp-conformance/index.js";
import { parseSseEvents } from "../../src/mcp-conformance/raw-capture.js";
import {
  createFixtureHandler,
  type BuildFixtureServerOptions,
} from "../support/dual-era-fixture.js";

/**
 * Exit gate for Phase 3 §11.5 (conformance era-awareness): pointing the
 * conformance suite at the modern (2026-07-28) dual-era fixture must produce
 * ZERO false failures and no crash, and a legacy run must behave exactly as
 * it did before era-awareness existed.
 *
 * The `serveFixtureOnPort` helper is vendored from
 * `mcp-client-manager-fixture.integration.test.ts` (not cross-imported): the
 * security host-header checks dial a real loopback socket, so the fixture
 * must be served over an actual port rather than driven in-process.
 */

interface ServedFixture {
  url: string;
  close: () => Promise<void>;
}

async function serveFixtureOnPort(
  options: BuildFixtureServerOptions = {},
): Promise<ServedFixture> {
  const handler = createFixtureHandler(options);
  const httpServer = http.createServer(toNodeHandler(handler));
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve)
  );
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

function byId(checks: MCPCheckResult[], id: MCPCheckId): MCPCheckResult {
  const found = checks.find((c) => c.id === id);
  if (!found) {
    throw new Error(`check ${id} not found in results`);
  }
  return found;
}

const ERA_SKIP = /Not applicable to the .* era/;

// Legacy-only checks — must be era-skipped on a modern run.
const LEGACY_ONLY: MCPCheckId[] = [
  "server-initialize",
  "ping",
  "logging-set-level",
  "server-sse-polling-session",
  "server-sse-streams-functional",
  "localhost-host-rebinding-rejected",
  "localhost-host-valid-accepted",
];

// Neutral checks that carry real surface on the modern fixture — must pass.
const MODERN_PASSING: MCPCheckId[] = [
  "capabilities-consistent",
  "tools-list",
  "tools-input-schemas-valid",
  "prompts-list",
  "resources-list",
  "protocol-invalid-method-error",
];

/**
 * Modern-only checks whose id is NOT `modern-`-prefixed. The SEP-2243
 * declaration check reads as one of the `tools-*` family in a report, but
 * `x-mcp-header` has no meaning before 2026-07-28, so it era-skips on legacy
 * exactly like the prefixed ones.
 */
const MODERN_ONLY_UNPREFIXED: MCPCheckId[] = [
  "tools-x-mcp-header-declarations-valid",
];

/**
 * Named `modern-` but not modern-only: "Servers MUST provide structured
 * results that conform to this schema" is in 2025-06-18 and 2025-11-25 too.
 */
const OUTPUT_SCHEMA_CHECK: MCPCheckId = "modern-tool-output-schema-conformant";

const isModernOnly = (id: MCPCheckId) =>
  id !== OUTPUT_SCHEMA_CHECK &&
  (id.startsWith("modern-") || MODERN_ONLY_UNPREFIXED.includes(id));

// Phase 7 §15.3 modern MUST checks the conforming beta.4 fixture satisfies.
//
// `modern-logs-require-log-level` is deliberately ABSENT. This run configures
// no `logProbe`, so the check has no request the server is known to log about
// and reports `could-not-run` (see the could-not-run assertion above). Listing
// it here asserted the opposite — that an unprobed run establishes the MUST —
// which is exactly the free pass the check used to hand out.
//
// `modern-no-session-id` stays: this fixture completes the modern handshake, so
// its responses are real exchanges the server could have attached a session to,
// and their silence is a verdict rather than an artifact of a dead session.
const MODERN_MUST_PASSING: MCPCheckId[] = [
  "modern-client-handshake",
  "modern-server-discover",
  "modern-result-type-present",
  "modern-cacheable-result-hints",
  "modern-protocol-version-header-mismatch",
  "modern-method-header-mismatch",
  "modern-name-header-mismatch",
  "modern-unsupported-version-error",
  "modern-removed-methods-not-found",
  "modern-resource-not-found-invalid-params",
  "modern-no-session-id",
];

// The two-fact rule: a raw rejection check must record the HTTP status AND the
// in-band JSON-RPC code separately, because the SDK delivers a 400 carrying a
// well-formed JSON-RPC error body IN-BAND — official-client evidence alone
// cannot tell those two facts apart.
const RAW_REJECTIONS: Array<{
  id: MCPCheckId;
  httpStatus: number;
  jsonRpcCode: number;
}> = [
  {
    id: "modern-protocol-version-header-mismatch",
    httpStatus: 400,
    jsonRpcCode: -32020,
  },
  { id: "modern-method-header-mismatch", httpStatus: 400, jsonRpcCode: -32020 },
  { id: "modern-name-header-mismatch", httpStatus: 400, jsonRpcCode: -32020 },
  {
    id: "modern-unsupported-version-error",
    httpStatus: 400,
    jsonRpcCode: -32022,
  },
  {
    // Record the fixture's HTTP status without making it a requirement.
    id: "modern-resource-not-found-invalid-params",
    httpStatus: 200,
    jsonRpcCode: -32602,
  },
];

describe("MCP conformance × era-awareness against the dual-era fixture", () => {
  let served: ServedFixture;

  beforeEach(async () => {
    served = await serveFixtureOnPort();
  });

  afterEach(async () => {
    await served.close();
  });

  it("modern run: zero failures, legacy-only checks era-skipped, neutral checks pass", async () => {
    const result = await new MCPConformanceTest({
      serverUrl: served.url,
      protocolVersion: "2026-07-28",
      checkTimeout: 10_000,
    }).run();

    // Exit gate: no false failures, no crash.
    expect(result.checks.filter((c) => c.status === "failed")).toEqual([]);
    // Two modern obligations need setup this fixture does not give: the
    // -32021 path needs an `inputRequiredProbe`, and the logging check needs a
    // `logProbe` naming a tool that actually logs. Both are gray "Not run" at
    // no cost. A graceful subscription close is server-initiated and cannot be
    // induced by a client-side probe, so it has nothing to test here.
    expect(result.outcome).toBe("passed");
    expect(
      result.checks
        .filter((c) => c.skipReason === "could-not-run")
        .map((c) => c.id)
        .sort(),
    ).toEqual([
      "modern-logs-require-log-level",
      "modern-undeclared-capability-error",
    ]);
    expect(
      byId(result.checks, "modern-subscription-graceful-close").skipReason,
    ).toBe("not-applicable");

    // Legacy-only checks appear (not filtered out) and are era-skipped.
    for (const id of LEGACY_ONLY) {
      const check = byId(result.checks, id);
      expect(check.status).toBe("skipped");
      expect(check.error?.message).toMatch(ERA_SKIP);
    }

    // Neutral checks with real surface pass on the modern era.
    for (const id of MODERN_PASSING) {
      expect(byId(result.checks, id).status).toBe("passed");
    }

    // The fixture's tools declare no `x-mcp-header` at all, so the SEP-2243
    // declaration check passes vacuously — which is the correct verdict.
    for (const id of MODERN_ONLY_UNPREFIXED) {
      expect([id, byId(result.checks, id).status]).toEqual([id, "passed"]);
    }

    // §15.3: the conforming modern fixture passes the modern MUST set.
    for (const id of MODERN_MUST_PASSING) {
      expect([id, byId(result.checks, id).status]).toEqual([id, "passed"]);
    }

    // Raw rejections record HTTP status and in-band JSON-RPC code separately.
    for (const { id, httpStatus, jsonRpcCode } of RAW_REJECTIONS) {
      expect(byId(result.checks, id).details).toMatchObject({
        httpStatus,
        jsonRpcCode,
      });
    }

    // The unsupported-version rejection must also advertise what IS supported.
    expect(
      byId(result.checks, "modern-unsupported-version-error").details
    ).toMatchObject({ supportedVersions: ["2026-07-28"] });

    // Every removed 2025 method answers -32601 with modern HTTP behavior.
    expect(
      byId(result.checks, "modern-removed-methods-not-found").details
    ).toMatchObject({
      removedMethods: {
        initialize: { httpStatus: 404, jsonRpcCode: -32601 },
        ping: { httpStatus: 404, jsonRpcCode: -32601 },
        "logging/setLevel": { httpStatus: 404, jsonRpcCode: -32601 },
      },
    });

    // The subscription checks run for real against this fixture: registering
    // tools/prompts/resources makes beta.4 advertise `listChanged`, so the
    // probe opens a live `subscriptions/listen` stream. Nothing publishes a
    // change event here, so the stream carries the acknowledgement alone —
    // enough to settle ordering and tagging, and not enough to settle a
    // graceful close, which is server-initiated and therefore an honest skip.
    // The failing paths are exercised in `subscription-checks.integration`.
    for (const id of [
      "modern-subscription-ack-precedes-notifications",
      "modern-subscription-filter-and-tagging",
    ] as const) {
      expect([id, byId(result.checks, id).status]).toEqual([id, "passed"]);
    }
    const gracefulClose = byId(
      result.checks,
      "modern-subscription-graceful-close"
    );
    expect(gracefulClose.status).toBe("skipped");
    expect(gracefulClose.error?.message).toMatch(/stayed open/);
    expect(gracefulClose.skipReason).toBe("not-applicable");

    // §15.4: any readiness advice is reported but never changes the verdict.
    for (const item of result.readiness) {
      expect(item.severity).toBe("warning");
      expect(["SHOULD", "MAY"]).toContain(item.specStrength);
      expect(item.message.length).toBeGreaterThan(0);
    }
    // The point of §15.4 is that advice never becomes a violation. `passed` is
    // false here only because two obligations could not be run, so assert the
    // thing readiness could have broken: it never turns the verdict red.
    expect(result.outcome).not.toBe("failed");

    // Completion still self-skips on capability, rather than the era gate.
    for (const id of ["completion-complete"] as const) {
      const check = byId(result.checks, id);
      expect(check.status).toBe("skipped");
      expect(check.error?.message).not.toMatch(ERA_SKIP);
    }
  });

  it("era-skips logging/setLevel even when a modern server advertises logging", async () => {
    await served.close();
    served = await serveFixtureOnPort({ logging: true });

    const result = await new MCPConformanceTest({
      serverUrl: served.url,
      protocolVersion: "2026-07-28",
      checkTimeout: 10_000,
      checkIds: ["logging-set-level", "modern-server-discover"],
    }).run();

    expect(
      byId(result.checks, "modern-server-discover").details?.capabilities,
    ).toContain("logging");
    expect(byId(result.checks, "modern-server-discover").status).toBe("passed");
    const check = byId(result.checks, "logging-set-level");
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("not-applicable");
    expect(check.error?.message).toMatch(ERA_SKIP);
    expect(result.passed).toBe(true);
  });

  it("auto run (no protocolVersion): detects the modern era", async () => {
    const result = await new MCPConformanceTest({
      serverUrl: served.url,
      checkTimeout: 10_000,
    }).run();

    expect(result.checks.filter((c) => c.status === "failed")).toEqual([]);
    // Two modern obligations need setup this fixture does not give: the
    // -32021 path needs an `inputRequiredProbe`, and the logging check needs a
    // `logProbe` naming a tool that actually logs. Both are gray "Not run" at
    // no cost. A graceful subscription close is server-initiated and cannot be
    // induced by a client-side probe, so it has nothing to test here.
    expect(result.outcome).toBe("passed");
    expect(
      result.checks
        .filter((c) => c.skipReason === "could-not-run")
        .map((c) => c.id)
        .sort(),
    ).toEqual([
      "modern-logs-require-log-level",
      "modern-undeclared-capability-error",
    ]);
    expect(
      byId(result.checks, "modern-subscription-graceful-close").skipReason,
    ).toBe("not-applicable");
    for (const id of LEGACY_ONLY) {
      const check = byId(result.checks, id);
      expect(check.status).toBe("skipped");
      expect(check.error?.message).toMatch(ERA_SKIP);
    }
    for (const id of MODERN_PASSING) {
      expect(byId(result.checks, id).status).toBe("passed");
    }
  });

  it("raw-only auto run still detects the modern era before raw checks", async () => {
    const result = await new MCPConformanceTest({
      serverUrl: served.url,
      checkIds: ["server-sse-polling-session"],
      checkTimeout: 10_000,
    }).run();

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      id: "server-sse-polling-session",
      status: "skipped",
    });
    expect(result.checks[0]?.error?.message).toMatch(ERA_SKIP);
  });

  it("legacy pin (2025-11-25): keeps the legacy checks active", async () => {
    const pinned = await new MCPConformanceTest({
      serverUrl: served.url,
      protocolVersion: "2025-11-25",
      checkTimeout: 10_000,
    }).run();

    // Only the modern-only checks may be era-skipped on a legacy pin; every
    // pre-Phase-7 check keeps its original status.
    // The output-schema check now asks its question here: this fixture's
    // tools declare no outputSchema, which it found out by listing them.
    const outputSchema = byId(pinned.checks, OUTPUT_SCHEMA_CHECK);
    expect(outputSchema.skipReason).toBe("not-applicable");
    expect(outputSchema.error?.message).toMatch(/No tool declares an outputSchema/);

    for (const check of pinned.checks) {
      if (check.id === OUTPUT_SCHEMA_CHECK) continue;
      if (isModernOnly(check.id)) {
        expect(check.status).toBe("skipped");
        expect(check.error?.message).toMatch(
          /Not applicable to the legacy era/
        );
        continue;
      }
      expect(check.error?.message ?? "").not.toMatch(ERA_SKIP);
    }
    expect(byId(pinned.checks, "server-initialize").status).toBe("passed");
    expect(byId(pinned.checks, "ping").status).toBe("passed");
    expect(byId(pinned.checks, "capabilities-consistent").status).toBe(
      "passed"
    );
    for (const id of MODERN_PASSING) {
      expect(byId(pinned.checks, id).status).toBe("passed");
    }
  });
});

describe("Tool Input Schemas Valid", () => {
  const checkId = "tools-input-schemas-valid";
  const invalid = { type: "object", properties: { name: { type: 42 } } };
  const draft07 = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { pair: { type: "array", items: [{ type: "string" }] } },
  };
  const externalRef = {
    type: "object",
    properties: { name: { $ref: "https://example.com/schemas/name.json" } },
  };
  const embeddedRef = {
    ...externalRef,
    $defs: {
      name: { $id: "https://example.com/schemas/name.json", type: "string" },
    },
  };
  const brokenLocalRef = { type: "object", $ref: "#/$defs/missing" };
  const externalDynamicRef = {
    type: "object",
    $dynamicRef: "https://example.com/schemas/name.json#name",
  };
  const mixed = [invalid, externalRef];

  it.each([
    ["2025-03-26", invalid, "passed"],
    ["2025-06-18", invalid, "passed"],
    ["2025-11-25", invalid, "failed"],
    ["2026-07-28", invalid, "failed"],
    [undefined, invalid, "failed"],
    ["2025-11-25", undefined, "passed"],
    ["2026-07-28", undefined, "passed"],
    ["2026-07-28", draft07, "passed"],
    ["2026-07-28", { ...draft07, $schema: "https://json-schema.org/draft/2019-09/schema" }, "skipped"],
    ["2025-06-18", externalRef, "passed"],
    ["2025-11-25", externalRef, "skipped"],
    ["2026-07-28", externalRef, "skipped"],
    ["2026-07-28", embeddedRef, "passed"],
    ["2026-07-28", brokenLocalRef, "failed"],
    ["2026-07-28", externalDynamicRef, "skipped"],
    ["2026-07-28", mixed, "failed"],
  ] as const)("on %s with schema %j returns %s", async (protocolVersion, inputSchema, status) => {
    const handler = createFixtureHandler();
    const result = await new MCPConformanceTest({
      serverUrl: "http://localhost/mcp",
      protocolVersion,
      checkIds: [checkId],
      readinessIds: [],
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        const method = request.method === "POST" ? (await request.clone().json()).method : undefined;
        const response = await handler.fetch(request);
        if (method !== "tools/list" || !inputSchema) return response;

        const isSse = response.headers.get("content-type")?.includes("text/event-stream");
        const body = isSse
          ? JSON.parse(parseSseEvents(await response.text()).find(({ data }) => data)?.data ?? "")
          : await response.json();
        if (inputSchema === mixed) {
          body.result.tools[0].inputSchema = invalid;
          body.result.tools.push({ name: "unsupported", inputSchema: externalRef });
        } else {
          body.result.tools[0].inputSchema = inputSchema;
        }
        if (isSse) {
          return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, response);
        }
        return Response.json(body, { headers: response.headers });
      },
    }).run();
    const check = byId(result.checks, checkId);
    expect(check.status, check.error?.message).toBe(status);
    if (status === "failed" && (inputSchema === invalid || inputSchema === mixed)) {
      expect(check.error?.message).toContain("inputSchema/properties/name/type");
    }
    if (inputSchema === brokenLocalRef) expect(check.error?.message).toContain("no target schema in the local document");
    if (inputSchema === mixed) expect(check.details?.unsupported).toMatchObject([{ tool: "unsupported" }]);
    if (status === "skipped") expect(check.skipReason).toBe("could-not-run");
  });
});

describe.each([undefined, "2026-07-28"] as const)("handshake selection %s", (protocolVersion) => {
  it.each([
    ["partial", true, "failed"],
    [null, true, "failed"],
    ["input_required", true, "failed"],
    ["complete", true, "passed"],
    [undefined, true, "passed"],
    // No identity: `io.modelcontextprotocol/serverInfo` is a SHOULD and an
    // optional field on 2026-07-28, so the handshake is still complete.
    ["complete", false, "passed"],
  ] as const)("checks discovery type %s with identity %s", async (resultType, identity, status) => {
    const handler = createFixtureHandler();
    let discoveries = 0;
    const result = await new MCPConformanceTest({
      serverUrl: "http://localhost/mcp",
      protocolVersion,
      checkIds: ["modern-client-handshake"],
      readinessIds: [],
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        const response = await handler.fetch(request);
        if (request.headers.get("Mcp-Method") !== "server/discover") return response;
        discoveries++;
        const body = await response.json();
        body.result.resultType = resultType;
        if (!identity) delete body.result._meta["io.modelcontextprotocol/serverInfo"];
        return Response.json(body, { headers: response.headers });
      },
    }).run();
    const check = byId(result.checks, "modern-client-handshake");
    expect(check.status, check.error?.message).toBe(status);
    if (resultType === "partial") expect(check.error?.message).toContain('Unrecognized resultType "partial"');
    expect(discoveries).toBe(1);
  });
});

it.each([
  {
    label: "an internal error",
    status: 200,
    reply: { error: { code: -32603, message: "Discovery failed in the fixture" } },
    verdict: "failed",
    reason: /-32603.*Discovery failed in the fixture/,
  },
  {
    label: "missing supportedVersions",
    status: 200,
    reply: { result: { resultType: "complete", capabilities: {} } },
    verdict: "failed",
    reason: /supportedVersions must be a non-empty array of strings/,
  },
  {
    label: "missing capabilities",
    status: 200,
    reply: { result: { resultType: "complete", supportedVersions: ["2026-07-28"] } },
    verdict: "failed",
    reason: /capabilities must be an object/,
  },
  {
    label: "array capabilities",
    status: 200,
    reply: {
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: [],
      },
    },
    verdict: "failed",
    reason: /capabilities must be an object/,
  },
  {
    label: "an explicit version refusal",
    status: 400,
    reply: {
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { requested: "2026-07-28", supported: ["2099-01-01"] },
      },
    },
    verdict: "skipped",
    reason: /It offers only 2099-01-01/,
  },
  {
    label: "a legacy method-not-found error",
    status: 200,
    reply: { error: { code: -32601, message: "Method not found" } },
    verdict: "skipped",
    reason: /does not support protocol version 2026-07-28/,
  },
])("grades $label from a pinned discovery probe", async ({ status, reply, verdict, reason }) => {
  const checkIds = ["modern-client-handshake", "modern-server-discover"] as const;
  const methods: string[] = [];
  const result = await new MCPConformanceTest({
    serverUrl: "http://localhost/mcp",
    protocolVersion: "2026-07-28",
    checkIds: [...checkIds],
    readinessIds: [],
    fetchFn: async (input, init) => {
      const request = new Request(input, init);
      const method = request.headers.get("Mcp-Method") ?? request.method;
      methods.push(method);
      const { id }: { id: string | number } = await request.json();
      return Response.json({ jsonrpc: "2.0", id, ...reply }, { status });
    },
  }).run();

  for (const id of checkIds) {
    const check = byId(result.checks, id);
    expect(check.status, `${id}: ${check.error?.message}`).toBe(verdict);
    expect(check.error?.message).toMatch(reason);
    if (verdict === "skipped") expect(check.skipReason).toBe("could-not-run");
  }
  expect(result.outcome).toBe(verdict === "failed" ? "failed" : "incomplete");
  expect(methods).toEqual(["server/discover"]);
});

describe.each(["raw", "mixed"] as const)("invalid discovery in a %s run", mode => {
  it.each(["partial", "input_required", null])("grades only usable evidence for %s", async resultType => {
    const handler = createFixtureHandler();
    const methods: string[] = [];
    const checkIds: MCPCheckId[] = [
      "modern-server-discover", "modern-result-type-present",
      "modern-cacheable-result-hints", "modern-cache-hint-coverage",
      "modern-cache-hint-values-valid", "modern-cache-scope-stable-across-pages",
      "modern-no-session-id",
    ];
    if (mode === "mixed") checkIds.push("capabilities-consistent", "modern-client-handshake");
    const result = await new MCPConformanceTest({
      serverUrl: "http://localhost/mcp",
      protocolVersion: mode === "raw" ? "2026-07-28" : undefined,
      checkIds,
      readinessIds: [],
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        const method = request.headers.get("Mcp-Method") ?? request.method;
        methods.push(method);
        const response = await handler.fetch(request);
        if (method !== "server/discover") return response;
        const body = await response.json();
        body.result.resultType = resultType;
        return Response.json(body, { headers: response.headers });
      },
    }).run();
    for (const id of checkIds) {
      const check = byId(result.checks, id);
      if (id === "modern-client-handshake" || id === "modern-result-type-present") {
        expect(check.status).toBe("failed");
        if (resultType === "input_required") {
          expect(check.error?.message).toBe(
            'server/discover returned "input_required", which the MCP spec forbids for this request',
          );
        }
      } else if (id === "modern-no-session-id") expect(check.status).toBe("passed");
      else expect(check.skipReason, id).toBe("could-not-run");
    }
    expect(methods).toEqual(mode === "raw" ? ["server/discover"] : ["server/discover", "server/discover"]);
  });
});

it("reports incomplete when Auto discovery fails and every selected client check is legacy-only", async () => {
  const handler = createFixtureHandler();
  const result = await new MCPConformanceTest({
    serverUrl: "http://localhost/mcp",
    checkIds: ["server-initialize"],
    readinessIds: [],
    fetchFn: async (input, init) => {
      const request = new Request(input, init);
      const response = await handler.fetch(request);
      if (request.headers.get("Mcp-Method") !== "server/discover") return response;
      const body = await response.json();
      body.result.resultType = "partial";
      return Response.json(body, { headers: response.headers });
    },
  }).run();
  expect(result.outcome).toBe("incomplete");
  expect(result.checks).toHaveLength(1);
  expect(result.checks[0]).toMatchObject({
    id: "server-initialize",
    skipReason: "could-not-run",
    error: { message: 'Unrecognized resultType "partial" in server/discover reply' },
  });
});
