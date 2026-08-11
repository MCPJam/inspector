import * as worker from "../src/worker";

describe("worker entrypoint", () => {
  it("exports doctor helpers for non-browser runtimes", () => {
    expect(typeof worker.runHttpServerDoctor).toBe("function");
    expect(typeof worker.redactForTelemetry).toBe("function");
    // Deprecated compatibility alias: external consumers still import it,
    // so its deletion must be a decision rather than an accident.
    expect(worker.redactSensitiveValue).toBe(worker.redactForTelemetry);
    expect(
      (worker as Record<string, unknown>).MCPClientManager
    ).toBeUndefined();
  });
});
