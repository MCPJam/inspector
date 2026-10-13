import { describe, expect, it } from "vitest";
import { buildLegacyLogRow, buildStrictLogRow } from "../strict-log";
import catalog from "../telemetry-catalog.generated.json";

describe("strict log boundary", () => {
  it("marks an internally minted Inspector canary route", () => {
    expect(
      buildStrictLogRow(
        "telemetry_canary",
        {},
        { canaryRoute: "private", canaryId: "private" },
      ),
    ).toMatchObject({
      event: "telemetry_canary",
      canaryRoute: "inspector",
      route: "inspector",
      canaryId: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
  it("preserves finite harness health dimensions without legacy prose", () => {
    const row = buildLegacyLogRow(
      "[harness][timing] claim=1ms PRIVATE_SENTINEL",
      {
        harnessId: "codex",
        harnessBakeExpected: "baked",
        harnessBakeOnBox: "present",
        harnessBootstrap: "installed",
        origin: "mcpjam",
        harnessRecipeIdentity: "PRIVATE_SENTINEL",
      },
    );
    expect(row).toMatchObject({
      event: "harness.timing",
      harnessId: "codex",
      harnessBakeExpected: "baked",
      harnessBakeOnBox: "present",
      harnessBootstrap: "installed",
      origin: "mcpjam",
    });
    expect(JSON.stringify(row)).not.toContain("PRIVATE_SENTINEL");
    expect(
      buildLegacyLogRow("[harness][timing][local] PRIVATE_SENTINEL", {}).event,
    ).toBe("log.unknown");
    expect(
      buildLegacyLogRow("[harness][bootstrap] turn=failed PRIVATE_SENTINEL", {
        harnessTurn: "failed",
      }),
    ).toMatchObject({ event: "harness.bootstrap", harnessTurn: "failed" });
    expect(
      buildLegacyLogRow(
        "[harness] turn failed",
        {},
        new TypeError("PRIVATE_SENTINEL"),
      ),
    ).toMatchObject({ event: "harness.turn.failed", errorClass: "TypeError" });
  });
  it("retains full mounted templates and rejects concrete customer paths", () => {
    expect(
      buildStrictLogRow(
        "http.request.failed",
        { method: "POST", route: "/api/web/chat-v2" },
        { statusCode: 500 },
      ),
    ).toMatchObject({
      route: "/api/web/chat-v2",
      errorClass: "UnknownError",
      errorCode: "unknown",
    });
    expect(
      buildStrictLogRow("http.request.failed", {
        method: "POST",
        route: "/api/web/private-customer-path",
      }),
    ).toMatchObject({ route: "unknown_route" });
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
