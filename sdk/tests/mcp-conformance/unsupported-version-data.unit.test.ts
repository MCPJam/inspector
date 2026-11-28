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
const ECHO_PROBLEM =
  'error.data.requested must be the version the client asked for ("1999-01-01"); this error has "2025-11-25"';
const NO_MCP_ANSWER =
  /^server\/discover returned HTTP \d+ with no JSON-RPC error body, so no MCP-layer response was observed to judge$/;

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

  it("reports a requested version that is not the one the client asked for", () => {
    const read = readUnsupportedVersionData(
      { supported: ["2026-07-28"], requested: "2025-11-25" },
      "1999-01-01",
    );

    expect(read.problems).toEqual([ECHO_PROBLEM]);
    // Kept, so the report shows what the server said.
    expect(read.requested).toBe("2025-11-25");
  });

  it("accepts the echo when it is the version the client asked for", () => {
    expect(readUnsupportedVersionData(GOOD, "1999-01-01").problems).toEqual([]);
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
  /** Answer with this body and content type instead of JSON-RPC (a gateway page). */
  raw?: { status: number; contentType: string; text: string };
  /** The request does not complete: fetch rejects with this. */
  throws?: Error;
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
    if (refusal.throws) throw refusal.throws;
    if (refusal.raw) {
      return new Response(refusal.raw.text, {
        status: refusal.raw.status,
        headers: { "content-type": refusal.raw.contentType, via: "1.1 gateway" },
      });
    }
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

async function grade(
  server: ReturnType<typeof serverRefusingWith>,
  signal?: AbortSignal,
) {
  const config = normalizeMCPConformanceConfig({
    serverUrl: SERVER_URL,
    protocolVersion: "2026-07-28",
    fetchFn: server.fetchFn,
    ...(signal ? { signal } : {}),
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

describe("check 31: the version the error says was requested", () => {
  it("fails when data.requested names another version", async () => {
    // Nacho's first point: the echo was only checked for being a string.
    const result = await grade(
      serverRefusingWith({
        data: { supported: ["2026-07-28"], requested: "2025-11-25" },
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe(PREFIX + ECHO_PROBLEM);
    expect(result.details).toMatchObject({ requestedVersion: "2025-11-25" });
  });
});

describe("check 31: answers it cannot judge (catalog 31.W1 and the shared W rules)", () => {
  it.each([
    ["a gateway's 502 page", 502, "<html><body>Bad gateway</body></html>"],
    ["a rate limiter's 429 page", 429, "<html><body>Too many requests</body></html>"],
    ["a gateway's 504 page", 504, "<html><body>Gateway timeout</body></html>"],
    ["a login wall", 401, "<html><body>Sign in</body></html>"],
  ])("could not run on %s: the server never answered", async (_label, status, text) => {
    const result = await grade(
      serverRefusingWith({ raw: { status, contentType: "text/html; charset=utf-8", text } }),
    );

    expect([result.status, result.skipReason]).toEqual(["skipped", "could-not-run"]);
    expect(result.error?.message).toMatch(NO_MCP_ANSWER);
    expect(result.details).toMatchObject({ httpStatus: status });
  });

  it("could not run when the server answers -32020 before it looks at the version", async () => {
    // The probe sends the same version in the header and the body. A server
    // that still answers HeaderMismatch never reached the version rule.
    const result = await grade(
      serverRefusingWith({ code: -32020, data: { header: "MCP-Protocol-Version" } }),
    );

    expect([result.status, result.skipReason]).toEqual(["skipped", "could-not-run"]);
    expect(result.error?.message).toBe(
      "The server answered HeaderMismatch (-32020) before it checked the protocol version, so the unsupported-version rule was not reached. This probe sends the same version in MCP-Protocol-Version and in the body.",
    );
    expect(result.details).toMatchObject({ httpStatus: 400, jsonRpcCode: -32020 });
  });

  it("could not run when the request does not complete", async () => {
    const result = await grade(
      serverRefusingWith({ throws: new DOMException("This operation was aborted", "AbortError") }),
    );

    expect([result.status, result.skipReason]).toEqual(["skipped", "could-not-run"]);
    expect(result.error?.message).toBe(
      "The request did not complete (This operation was aborted), so no answer to an unsupported version was observed to judge",
    );
  });

  it("stops without a verdict when the run is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      grade(serverRefusingWith({ data: GOOD }), controller.signal),
    ).rejects.toThrow();
  });

  it("still fails a JSON-RPC answer with the wrong code, which is the server's own", async () => {
    const result = await grade(serverRefusingWith({ code: -32602, status: 400, data: GOOD }));

    expect(result.status).toBe("failed");
  });
});
