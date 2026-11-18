/**
 * `modern-undeclared-capability-error` fails only on input the client could
 * not have declared support for.
 *
 * basic/patterns/mrtr#server-requirements-basic-workflow: "Servers MUST include
 * at least one of `inputRequests` or `requestState` in every
 * `InputRequiredResult`" and "Servers MUST NOT send an `inputRequests` that the
 * client has not declared support for in its capabilities". An
 * `InputRequiredResult` that carries `requestState` alone asks the client only
 * to retry: it relies on no client capability, so it is not the violation this
 * check exists to catch.
 */

import { describe, expect, it } from "vitest";
import { runModernChecks } from "../../src/mcp-conformance/checks/modern.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";

const CHECK = "modern-undeclared-capability-error" as const;
const CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function runCheck(
  answer: (body: { id: unknown; method: string }) => Response
) {
  const declared: unknown[] = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "tools/call") {
      declared.push(body.params?._meta?.[CAPABILITIES_META]);
    }
    return answer(body);
  };
  const config = normalizeMCPConformanceConfig({
    serverUrl: "https://mrtr.example.test/mcp",
    protocolVersion: "2026-07-28",
    inputRequiredProbe: { toolName: "confirm" },
    fetchFn,
  });
  const results = await runModernChecks(
    { config, serverUrl: config.serverUrl, fetchFn: config.fetchFn },
    new Set([CHECK])
  );
  return { check: results[0], declared };
}

describe("modern-undeclared-capability-error", () => {
  it("does not fail an input_required result that carries only requestState", async () => {
    const { check, declared } = await runCheck((body) =>
      json({
        jsonrpc: "2.0",
        id: body.id,
        result: { resultType: "input_required", requestState: "opaque-state" },
      })
    );
    // The probe declared no client capabilities: the condition under test.
    expect(declared).toEqual([{}]);
    expect(check).toMatchObject({
      status: "skipped",
      skipReason: "could-not-run",
    });
    expect(check.error?.message).toContain("without any inputRequests");
    expect(check.details).toMatchObject({
      resultType: "input_required",
      hasRequestState: true,
    });
  });

  it("does not fail an input_required result whose inputRequests map is empty", async () => {
    const { check } = await runCheck((body) =>
      json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          resultType: "input_required",
          inputRequests: {},
          requestState: "opaque-state",
        },
      })
    );
    expect(check).toMatchObject({
      status: "skipped",
      skipReason: "could-not-run",
    });
  });

  it("fails when the server sends an input request the client never declared", async () => {
    const { check } = await runCheck((body) =>
      json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          resultType: "input_required",
          inputRequests: {
            q: {
              method: "elicitation/create",
              params: { message: "Continue?", requestedSchema: {} },
            },
          },
          requestState: "opaque-state",
        },
      })
    );
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("it must answer JSON-RPC -32021");
    expect(check.details).toMatchObject({
      requestedInputs: ["elicitation/create"],
    });
  });

  it("passes the -32021 rejection on HTTP 400 that names the capability", async () => {
    const { check } = await runCheck((body) =>
      json(
        {
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: -32021,
            message: "Missing required client capability",
            data: { requiredCapabilities: { elicitation: {} } },
          },
        },
        400
      )
    );
    expect(check.status).toBe("passed");
    expect(check.details).toMatchObject({ httpStatus: 400, jsonRpcCode: -32021 });
  });
});
