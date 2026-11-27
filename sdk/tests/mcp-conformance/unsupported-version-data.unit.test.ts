/**
 * Check 31 (`modern-unsupported-version-error`) and the `data` of the error.
 *
 * The 2026-07-28 schema types `UnsupportedProtocolVersionError.error.data` as
 * `{ supported: string[]; requested: string }`, both required
 * (`schema.ts:483-499`). The check accepted the list under another name
 * (`supportedVersions`) and never read `requested`, so an error missing either
 * member passed.
 *
 * These pin how the data is read, and then the check itself against a
 * scripted 2026-07-28 server.
 */

import { describe, expect, it } from "vitest";
import { runModernChecks } from "../../src/mcp-conformance/checks/modern.js";
import { readUnsupportedVersionData } from "../../src/mcp-conformance/checks/unsupported-version-data.js";
import type { MCPCheckId } from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";

const ID: MCPCheckId = "modern-unsupported-version-error";
const SERVER_URL = "http://127.0.0.1:9/mcp";

const SUPPORTED_PROBLEM =
  "error.data.supported must list the supported protocol versions as a non-empty array of strings";
const ALIAS_PROBLEM = `${SUPPORTED_PROBLEM}; this error has the list under supportedVersions, which is not the name the schema gives it`;
const REQUESTED_PROBLEM =
  "error.data.requested must be the protocol version the client asked for, as a string";

const GOOD = { supported: ["2026-07-28"], requested: "1999-01-01" };

describe("readUnsupportedVersionData", () => {
  it("reads both members the schema requires", () => {
    expect(readUnsupportedVersionData(GOOD)).toEqual({ ...GOOD, problems: [] });
  });

  it("allows other members next to them", () => {
    expect(
      readUnsupportedVersionData({ ...GOOD, hint: "upgrade" }).problems,
    ).toEqual([]);
  });

  it.each([
    ["missing", { requested: "1999-01-01" }],
    ["an empty list", { supported: [], requested: "1999-01-01" }],
    ["a string, not a list", { supported: "2026-07-28", requested: "1999-01-01" }],
    ["a list with a number in it", { supported: ["2026-07-28", 2], requested: "1999-01-01" }],
    ["null", { supported: null, requested: "1999-01-01" }],
  ])("reports supported when it is %s", (_label, data) => {
    const read = readUnsupportedVersionData(data);

    expect(read.problems).toEqual([SUPPORTED_PROBLEM]);
    expect(read).not.toHaveProperty("supported");
    expect(read.requested).toBe("1999-01-01");
  });

  it("does not take supportedVersions for supported, and says where the list is", () => {
    const read = readUnsupportedVersionData({
      supportedVersions: ["2026-07-28"],
      requested: "1999-01-01",
    });

    expect(read.problems).toEqual([ALIAS_PROBLEM]);
    expect(read).not.toHaveProperty("supported");
  });

  it("reads supported when the alias is there too", () => {
    expect(
      readUnsupportedVersionData({ ...GOOD, supportedVersions: ["other"] }),
    ).toEqual({ ...GOOD, problems: [] });
  });

  it.each([
    ["missing", { supported: ["2026-07-28"] }],
    ["a number", { supported: ["2026-07-28"], requested: 1999 }],
    ["null", { supported: ["2026-07-28"], requested: null }],
  ])("reports requested when it is %s", (_label, data) => {
    const read = readUnsupportedVersionData(data);

    expect(read.problems).toEqual([REQUESTED_PROBLEM]);
    expect(read).not.toHaveProperty("requested");
    expect(read.supported).toEqual(["2026-07-28"]);
  });

  it("reports both, supported first, when neither is there", () => {
    expect(readUnsupportedVersionData({}).problems).toEqual([
      SUPPORTED_PROBLEM,
      REQUESTED_PROBLEM,
    ]);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "unsupported"],
    ["an array", ["2026-07-28"]],
  ])("reports data that is %s as not an object", (_label, data) => {
    expect(readUnsupportedVersionData(data).problems).toEqual([
      "error.data must be an object with the supported protocol versions (supported) and the requested one (requested)",
    ]);
  });
});

/** A 2026-07-28 server that refuses the unsupported version this way. */
function serverRefusingWith(refusal: {
  status?: number;
  code?: number;
  data?: unknown;
  /** Answer the probe with a result, as if the version were supported. */
  serve?: boolean;
}) {
  const probes: Array<{ header: string | null; envelope: unknown }> = [];
  const fetchFn = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id: unknown;
      params?: { _meta?: Record<string, unknown> };
    };
    probes.push({
      header: new Headers(init?.headers as HeadersInit).get(
        "mcp-protocol-version",
      ),
      envelope: body.params?._meta?.["io.modelcontextprotocol/protocolVersion"],
    });
    const payload = refusal.serve
      ? { result: { supportedVersions: ["2026-07-28"], capabilities: {} } }
      : {
          error: {
            code: refusal.code ?? -32022,
            message: "Unsupported protocol version",
            ...("data" in refusal ? { data: refusal.data } : {}),
          },
        };
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }),
      {
        status: refusal.serve ? 200 : (refusal.status ?? 400),
        headers: { "content-type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;
  return { fetchFn, probes };
}

async function grade(server: ReturnType<typeof serverRefusingWith>) {
  const config = normalizeMCPConformanceConfig({
    serverUrl: SERVER_URL,
    protocolVersion: "2026-07-28",
    fetchFn: server.fetchFn,
  });
  const results = await runModernChecks(
    { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn },
    new Set([ID]),
  );
  expect(results).toHaveLength(1);
  return results[0]!;
}

const PREFIX = "Unsupported envelope version was not rejected as required: ";

describe("check 31: the error a 2026-07-28 server answers an unsupported version with", () => {
  it("passes HTTP 400 with -32022, supported and requested", async () => {
    const server = serverRefusingWith({ data: GOOD });
    const result = await grade(server);

    expect(result.status).toBe("passed");
    expect(result.details).toMatchObject({
      httpStatus: 400,
      jsonRpcCode: -32022,
      supportedVersions: ["2026-07-28"],
      requestedVersion: "1999-01-01",
    });
    // The probe: header and envelope agree on a version no server has.
    expect(server.probes).toEqual([
      { header: "1999-01-01", envelope: "1999-01-01" },
    ]);
  });

  it("fails when the list sits under supportedVersions", async () => {
    // The first case in the card: this used to pass.
    const result = await grade(
      serverRefusingWith({
        data: { supportedVersions: ["2026-07-28"], requested: "1999-01-01" },
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe(PREFIX + ALIAS_PROBLEM);
    expect(result.details).not.toHaveProperty("supportedVersions", [
      "2026-07-28",
    ]);
  });

  it("fails when data.requested is missing", async () => {
    // The second case in the card: this used to pass.
    const result = await grade(
      serverRefusingWith({ data: { supported: ["2026-07-28"] } }),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe(PREFIX + REQUESTED_PROBLEM);
  });

  it("fails when data.supported is missing, as it did", async () => {
    const result = await grade(
      serverRefusingWith({ data: { requested: "1999-01-01" } }),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe(PREFIX + SUPPORTED_PROBLEM);
  });

  it("fails when the error carries no data at all", async () => {
    const result = await grade(serverRefusingWith({}));

    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("error.data must be an object");
  });

  it("names every problem when the status, and the data, are wrong", async () => {
    const result = await grade(
      serverRefusingWith({ status: 200, data: { supported: ["2026-07-28"] } }),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe(
      `${PREFIX}expected HTTP 400, got HTTP 200; ${REQUESTED_PROBLEM}`,
    );
  });

  it("names the code alone when only the code is wrong", async () => {
    const result = await grade(serverRefusingWith({ code: -32602, data: GOOD }));

    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe(
      `${PREFIX}expected in-band JSON-RPC code -32022, got -32602`,
    );
  });

  it("reports a served request as not rejected, with no data problem", async () => {
    const result = await grade(serverRefusingWith({ serve: true }));

    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe(
      `${PREFIX}expected HTTP 400, got HTTP 200; expected an in-band JSON-RPC error object, got none`,
    );
  });
});
