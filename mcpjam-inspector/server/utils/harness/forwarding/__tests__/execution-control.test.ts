import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionControl } from "../execution-control.js";
const owner = {
  kind: "chat" as const,
  userId: "user",
  serverId: "server",
  harnessSessionId: "session",
};
const intent = {
  invocationKey: "one",
  turnId: "turn",
  rpcId: 1,
  method: "tools/call",
  paramsJson: "{}",
  expiresAt: 123,
};
beforeEach(() =>
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-secret-for-tests"),
);
afterEach(() => vi.unstubAllEnvs());
describe("execution control client", () => {
  it("uses separate service and model credentials and the trusted backend origin", async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json({
        executionId: "id",
        state: "prepared",
        replayed: false,
        requireToolApproval: true,
      }),
    );
    const control = createExecutionControl({
      owner,
      token: "model-grant",
      baseUrl: "https://backend.example",
      fetch: transport,
    });
    await control.prepare(intent);
    const [url, init] = transport.mock.calls[0];
    expect(String(url)).toBe(
      "https://backend.example/internal/v1/harness-forwarding/executions",
    );
    expect(new Headers(init.headers).get("x-inspector-service-token")).toBe(
      "service-secret-for-tests",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      owner,
      token: "model-grant",
      operation: { kind: "prepare", ...intent },
    });
  });
  it("settles without an expired model credential and does not retry errors", async () => {
    const transport = vi.fn<typeof fetch>(
      async () => new Response("private-provider-secret", { status: 503 }),
    );
    const control = createExecutionControl({
      owner,
      token: "expired-grant",
      baseUrl: "https://backend.example",
      fetch: transport,
    });
    await expect(
      control.settle("id", "dispatch", { outcome: "incomplete" }),
    ).rejects.toThrow("control_503");
    expect(transport).toHaveBeenCalledOnce();
    expect(String(transport.mock.calls[0][1].body)).not.toContain(
      "expired-grant",
    );
    expect(String(transport.mock.calls[0][1].body)).not.toContain('"owner"');
  });
  it("rejects malformed success before allowing the gate to proceed", async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json({ dispatch: "yes" }),
    );
    const control = createExecutionControl({
      owner,
      token: "grant",
      baseUrl: "https://backend.example",
      fetch: transport,
    });
    await expect(control.claim("id", "key")).rejects.toThrow(
      "invalid_control_response",
    );
    expect(transport).toHaveBeenCalledOnce();
  });
  it("refuses a result that cannot fit the backend control envelope", async () => {
    const transport = vi.fn();
    const control = createExecutionControl({
      owner,
      token: "grant",
      baseUrl: "https://backend.example",
      fetch: transport,
    });
    await expect(
      control.settle("id", "key", {
        outcome: "success",
        resultJson: '"' + "x".repeat(8 * 1024 * 1024) + '"',
      }),
    ).rejects.toThrow("evidence_too_large");
    expect(transport).not.toHaveBeenCalled();
  });
});
