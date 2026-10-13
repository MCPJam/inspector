import { describe, expect, it } from "vitest";
import { buildStrictLogRow } from "../strict-log";
import catalog from "../telemetry-catalog.generated.json";

describe("strict log boundary", () => {
  it("retains full mounted templates and rejects concrete customer paths", () => {
    expect(buildStrictLogRow("http.request.failed", { method: "POST", route: "/api/web/chat-v2" }, { statusCode: 500 })).toMatchObject({ route: "/api/web/chat-v2", errorClass: "UnknownError", errorCode: "unknown" });
    expect(buildStrictLogRow("http.request.failed", { method: "POST", route: "/api/web/private-customer-path" })).toMatchObject({ route: "unknown_route" });
  });
  it("preserves catalog diagnostics and rejects prose and payload context overrides", () => {
    const sentinel = "PRIVATE_SENTINEL";
    const row = buildStrictLogRow(
      "http.request.failed",
      {
        route: "/api/web/*",
        environment: "prod",
        method: "POST",
        requestId: "ab5fb35f-4604-4d5b-8724-fd2e69539cbe",
      },
      {
        statusCode: 500,
        durationMs: 24,
        credentialPresented: true,
        message: sentinel,
        userAgent: sentinel,
        route: sentinel,
        requestId: sentinel,
      },
      new TypeError(sentinel),
    );
    expect(JSON.stringify(row)).not.toContain(sentinel);
    expect(row).toMatchObject({
      event: "http.request.failed",
      errorClass: "TypeError",
      knownError: true,
      statusCode: 500,
      durationMs: 24,
      credentialPresented: true,
      environment: "prod",
    });
  });
  it("fails closed for unknown event names, paths, enums and nonfinite numbers", () => {
    expect(catalog.events).toContain("http.request.failed");
    const row = buildStrictLogRow(
      "PRIVATE_SENTINEL",
      { route: "/PRIVATE_SENTINEL", environment: "PRIVATE_SENTINEL" },
      { durationMs: Infinity, statusCode: -1 },
    );
    expect(row).toMatchObject({ event: "log.unknown", route: "unknown_route" });
    expect(row).not.toHaveProperty("durationMs");
    expect(JSON.stringify(row)).not.toContain("PRIVATE_SENTINEL");
  });
});
