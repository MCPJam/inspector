import * as worker from "../src/worker";

describe("worker entrypoint", () => {
  it("exports doctor helpers for non-browser runtimes", () => {
    expect(typeof worker.runHttpServerDoctor).toBe("function");
    expect(typeof worker.redactSensitiveValue).toBe("function");
    expect(
      (worker as Record<string, unknown>).MCPClientManager
    ).toBeUndefined();
  });
});
