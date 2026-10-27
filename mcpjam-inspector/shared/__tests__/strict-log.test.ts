import { describe, expect, it } from "vitest";
import {
  buildLegacyLogRow,
  buildStrictLogRow,
  strictLogFieldRule,
} from "../strict-log";
import catalog from "../telemetry-catalog.generated.json";

describe("strict log boundary", () => {
  it.each(["fetch_failed", "invalid_catalog"])(
    "retains a catalog refresh failure with bounded reason %s and warning level",
    (reason) => {
      const row = buildStrictLogRow(
        "model_catalog.refresh.failed",
        {},
        {
          reason,
          level: "error",
          url: "PRIVATE_SENTINEL",
          error: "PRIVATE_SENTINEL",
        },
      );
      expect(row).toMatchObject({
        event: "model_catalog.refresh.failed",
        level: "warn",
        reason,
      });
      expect(JSON.stringify(row)).not.toContain("PRIVATE_SENTINEL");
    },
  );
  it.each(["startup", "PRIVATE_SENTINEL", undefined])(
    "omits a reason outside the catalog-refresh enum: %s",
    (reason) => {
      const row = buildStrictLogRow(
        "model_catalog.refresh.failed",
        {},
        { reason },
      );
      expect(row).toMatchObject({
        event: "model_catalog.refresh.failed",
        level: "warn",
      });
      expect(row).not.toHaveProperty("reason");
    },
  );
  it("retains the exact payment refusal only on its billing failure event", () => {
    const context = { reason: "payment_not_confirmed" };
    const payload = { errorCode: "agent_billing_rejected" };
    expect(buildStrictLogRow("route.operation.failed", context, payload))
      .toMatchObject({ ...context, ...payload });
    for (const [event, reason, code] of [
      ["http.request.failed", "payment_not_confirmed", "agent_billing_rejected"],
      ["route.operation.failed", "payment_not_confirmed", "unknown"],
      ["route.operation.failed", "PRIVATE_SENTINEL", "agent_billing_rejected"],
    ]) {
      expect(buildStrictLogRow(event, { reason }, { errorCode: code }))
        .not.toHaveProperty("reason");
    }
  });


  it("retains catalogued source messages while dropping runtime text", () => {
    const message = "[host-runtime-config] network error";
    expect(catalog.messages).toContain(message);
    expect(buildLegacyLogRow(message, {}, new Error("PRIVATE_SENTINEL"))).toMatchObject({
      event: expect.stringMatching(/^log\.[0-9a-f]{16}$/), message,
    });
    const injected = buildLegacyLogRow(`${message} PRIVATE_SENTINEL`, {});
    expect(injected.event).toBe("log.unknown");
    expect(injected).not.toHaveProperty("message");
  });

  it("retains the typed unattested-IP containment signal", () => {
    expect(buildStrictLogRow("llm_spend_unattested_ip_pooled", { environment: "prod" }))
      .toMatchObject({ event: "llm_spend_unattested_ip_pooled", environment: "prod" });
  });
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
  it("names a dependency error class and keeps an unlisted one unknown", () => {
    const named = (name: string) =>
      Object.assign(new Error("PRIVATE_SENTINEL"), { name });
    expect(
      buildStrictLogRow("http.request.failed", {}, {}, named("McpError")),
    ).toMatchObject({ errorClass: "McpError", knownError: true });
    expect(
      buildStrictLogRow(
        "http.request.failed",
        {},
        {},
        named("PRIVATE_SENTINEL"),
      ),
    ).toMatchObject({ errorClass: "UnknownError", knownError: false });
  });
  it("copies Convex IDs from the server's context and never from a payload", () => {
    const [org, project, server, forged] = ["org", "project", "server", "forged"]
      .map((seed) => seed.padEnd(32, "0"));
    const payload = { orgId: forged, projectId: forged, serverId: forged };
    expect(
      buildStrictLogRow(
        "mcp.tool.execution.failed",
        { orgId: org, projectId: project, serverId: server, sessionId: server },
        payload,
      ),
    ).toMatchObject({ orgId: org, projectId: project, serverId: server });
    for (const context of [
      {},
      { orgId: null, projectId: null, serverId: null },
      { orgId: forged.toUpperCase(), projectId: `${project}0`, serverId: 7 },
      { orgId: `PRIVATE_SENTINEL ${org}` },
    ]) {
      const row = buildStrictLogRow("mcp.tool.execution.failed", context, payload);
      for (const key of ["orgId", "projectId", "serverId", "sessionId"])
        expect(row).not.toHaveProperty(key);
      expect(JSON.stringify(row)).not.toContain("PRIVATE_SENTINEL");
    }
  });
  it("takes no ID from a legacy row's context, harness rows included", () => {
    const ids = { orgId: "org".padEnd(32, "0"), projectId: "p".padEnd(32, "0") };
    for (const message of ["[harness][timing] claim=1ms", "[harness] turn failed"]) {
      const row = buildLegacyLogRow(message, { ...ids, harnessId: "codex" });
      expect(row).toMatchObject({ harnessId: "codex" });
      expect(row).not.toHaveProperty("orgId");
      expect(row).not.toHaveProperty("projectId");
    }
  });
  it("drops fields named after Object.prototype members instead of throwing", () => {
    const fields = JSON.parse(
      '{"toString":"x","constructor":"ok","hasOwnProperty":1,"valueOf":true,"__proto__":"x"}',
    );
    for (const key of Object.keys(fields))
      expect(strictLogFieldRule(key)).toBeUndefined();
    const row = buildStrictLogRow("http.request.failed", fields, fields);
    for (const key of Object.keys(fields))
      expect(Object.hasOwn(row, key)).toBe(false);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(buildLegacyLogRow("[harness] turn failed", fields)).toMatchObject({
      event: "harness.turn.failed",
    });
  });
});
