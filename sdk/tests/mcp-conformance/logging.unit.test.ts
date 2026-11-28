import { describe, expect, it } from "vitest";
import { runModernChecks } from "../../src/mcp-conformance/checks/modern.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";
import type { MCPCheckId } from "../../src/mcp-conformance/types.js";
import { featuresForCheck } from "../../src/server-features/check-map/index.js";

const LOGGING_CHECKS = ["modern-logs-require-log-level"] as const;

async function runCheck(id: MCPCheckId, fetchFn: typeof fetch) {
  const config = normalizeMCPConformanceConfig({
    serverUrl: "https://logging.example.test/mcp",
    protocolVersion: "2026-07-28",
    logProbe: { toolName: "emit-log" },
    fetchFn,
  });
  const results = await runModernChecks(
    { config, serverUrl: config.serverUrl, fetchFn: config.fetchFn },
    new Set([id])
  );
  return results[0];
}

function completed(id: unknown) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { resultType: "complete", content: [] },
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

describe("modern logging unavailable probes", () => {
  for (const id of LOGGING_CHECKS) {
    for (const failure of [
      "http",
      "rpc",
      "unfinished",
      "transport",
      "body",
    ] as const) {
      it(`${id}: reports ${failure} failure as could-not-run`, async () => {
        const fetchFn: typeof fetch = async (_input, init) => {
          const body = JSON.parse(String(init?.body));
          // The opt-in check first proves silence on a completed unrequested call.
          if (!body.params?._meta?.["io.modelcontextprotocol/logLevel"]) {
            return completed(body.id);
          }
          switch (failure) {
            case "http":
              return new Response("Unauthorized", { status: 401 });
            case "rpc":
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: body.id,
                  error: { code: -32601, message: "Tool not found" },
                }),
                { headers: { "Content-Type": "application/json" } }
              );
            case "unfinished":
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: body.id,
                  result: { resultType: "input_required", inputRequests: [] },
                }),
                { headers: { "Content-Type": "application/json" } }
              );
            case "transport":
              throw new TypeError("connection reset");
            case "body":
              return new Response(
                new ReadableStream({
                  start(controller) {
                    controller.error(new Error("broken body"));
                  },
                }),
                { headers: { "Content-Type": "text/event-stream" } }
              );
          }
        };
        const check = await runCheck(id, fetchFn);
        expect(check).toMatchObject({
          status: "skipped",
          skipReason: "could-not-run",
        });
        expect(check.error?.message).not.toContain(
          "the supplied tool produced no logs"
        );
      });
    }
  }
});

describe("modern-logs-require-log-level with a tool that never logs", () => {
  // Hello MCP `?logs=silent`, catalog 40.P3: the tool answers both calls and
  // sends no log. Sending logs after opting in is a MAY (2026-07-28
  // `server/utilities/logging.mdx`), so the silence is not a violation.
  const silent: typeof fetch = async (_input, init) =>
    completed(JSON.parse(String(init?.body)).id);

  it("passes, with both counts at zero", async () => {
    const check = await runCheck("modern-logs-require-log-level", silent);

    expect(check.status).toBe("passed");
    expect(check.error).toBeUndefined();
    expect(check.details).toMatchObject({
      logNotificationCount: 0,
      logNotificationCountWithLevel: 0,
      requestedLogLevel: "debug",
      probedTool: "emit-log",
    });
  });

  it("is not evidence for the logging features", () => {
    // A pass no longer shows that the server logs: a server that never logs
    // passes too. So it must not mark log messages or the per-request level as
    // present on the server-features page.
    expect(featuresForCheck("protocol:modern-logs-require-log-level")).toEqual(
      []
    );
  });
});
