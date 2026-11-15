import { describe, expect, it } from "vitest";
import { createCapturingFetch } from "../../src/mcp-conformance/raw-capture.js";
import { WireObservationRecorder } from "../../src/mcp-conformance/wire-observations.js";
import { WireSchemaValidator } from "../../src/mcp-conformance/wire-schema.js";

describe("HTTP rejection bodies and JSON-RPC schema validation", () => {
  it.each([
    { method: "GET", status: 405, violations: 0 },
    { method: "GET", status: 200, violations: 1 },
    { method: "GET", status: 400, violations: 1 },
    { method: "POST", status: 405, violations: 1 },
    { method: "POST", status: 200, violations: 1 },
  ])(
    "$method $status retains $violations schema violations",
    async ({ method, status, violations }) => {
      const body = { error: "Use POST" };
      const capture = createCapturingFetch(
        async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: {
              "content-type": "application/json",
              allow: "POST, DELETE",
            },
          })
      );
      await capture.fetch("http://localhost/mcp", { method });
      const recorder = new WireObservationRecorder();
      recorder.recordExchange(capture.exchanges[0]);
      const validator = new WireSchemaValidator({
        protocolVersion: "2025-11-25",
      });
      expect(validator.validate(recorder.observations).violations).toHaveLength(
        violations
      );

      // Excluding a transport refusal from JSON-RPC grading must not erase the
      // HTTP exchange: transport checks and diagnostic evidence still need it.
      expect(capture.exchanges[0].response).toMatchObject({
        status,
        headers: { allow: "POST, DELETE" },
        bodyText: JSON.stringify(body),
        json: body,
      });
    }
  );

  it("still validates real JSON-RPC responses after a GET refusal", async () => {
    const capture = createCapturingFetch(
      async (_input, init) =>
        new Response(
          JSON.stringify(
            init?.method === "GET"
              ? { error: "Use POST" }
              : { jsonrpc: "2.0", id: 1, result: { content: "invalid" } }
          ),
          {
            status: init?.method === "GET" ? 405 : 200,
            headers: { "content-type": "application/json" },
          }
        )
    );
    await capture.fetch("http://localhost/mcp", { method: "GET" });
    await capture.fetch("http://localhost/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
    });
    const recorder = new WireObservationRecorder();
    for (const exchange of capture.exchanges) recorder.recordExchange(exchange);
    const report = new WireSchemaValidator({
      protocolVersion: "2025-11-25",
    }).validate(recorder.observations);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].definition).toBe("CallToolResult");
    expect(report.violations[0].errors.join(" ")).toContain("/content");
  });
});
