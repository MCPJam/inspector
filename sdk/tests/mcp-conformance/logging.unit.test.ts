import { describe, expect, it } from "vitest";
import { runModernChecks } from "../../src/mcp-conformance/checks/modern.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";
import type { MCPCheckId } from "../../src/mcp-conformance/types.js";

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
      });
    }
  }
});

describe("modern-logs-require-log-level verdicts", () => {
  const LOG_LEVEL_META = "io.modelcontextprotocol/logLevel";

  function logged(id: unknown) {
    const frames = [
      {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "info", data: "working" },
      },
      { jsonrpc: "2.0", id, result: { resultType: "complete", content: [] } },
    ];
    return new Response(
      frames
        .map((frame) => `event: message
data: ${JSON.stringify(frame)}

`)
        .join(""),
      { headers: { "Content-Type": "text/event-stream" } }
    );
  }

  // server/utilities/logging#per-request-log-level: with the field present the
  // server MAY send notifications/message. Emitting none is conformant.
  it("passes a server that emits no logs after the client opts in", async () => {
    const levels: unknown[] = [];
    const check = await runCheck(
      "modern-logs-require-log-level",
      async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        levels.push(body.params?._meta?.[LOG_LEVEL_META]);
        return completed(body.id);
      }
    );
    expect(levels).toEqual([undefined, "debug"]);
    expect(check.status).toBe("passed");
    expect(check.error).toBeUndefined();
    expect(check.details).toMatchObject({
      logNotificationCount: 0,
      logNotificationCountWithLevel: 0,
    });
  });

  it("passes a server that logs only after the client opts in", async () => {
    const check = await runCheck(
      "modern-logs-require-log-level",
      async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        return body.params?._meta?.[LOG_LEVEL_META]
          ? logged(body.id)
          : completed(body.id);
      }
    );
    expect(check.status).toBe("passed");
    expect(check.details).toMatchObject({ logNotificationCountWithLevel: 1 });
  });

  // The MUST NOT half is unchanged: logs on a request with no level fail.
  it("fails a server that logs on a request that carried no log level", async () => {
    const check = await runCheck(
      "modern-logs-require-log-level",
      async (_input, init) => logged(JSON.parse(String(init?.body)).id)
    );
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain(
      "for a request that carried no modern log level"
    );
    expect(check.details).toMatchObject({ logNotificationCount: 1 });
  });
});
