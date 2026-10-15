import { describe, expect, it } from "vitest";
import { explainTelemetry, expectTelemetryFields } from "./explain-telemetry";

const USER = "user_01HZ0000000000000000000000";

describe("explainTelemetry: Axiom log rows", () => {
  const sample = {
    log: "http.request.failed",
    context: {
      route: "/api/web/chat-v2",
      method: "POST",
      statusCode: 502,
      durationMs: 1200,
      customerPrompt: "summarize my private doc",
    },
  };

  it("forwards declared fields and names the rule that drops the rest", () => {
    const { forwarded, dropped } = explainTelemetry(sample);
    expect(forwarded).toMatchObject({ event: "http.request.failed", route: "/api/web/chat-v2", statusCode: 502 });
    expect(forwarded).not.toHaveProperty("customerPrompt");
    expect(dropped.customerPrompt).toMatch(/no field rule: declare it in server\/utils\/log-events\.ts/);
    expect(expectTelemetryFields(sample, ["statusCode", "durationMs"])).toMatchObject({ statusCode: 502, durationMs: 1200 });
    expect(() => expectTelemetryFields(sample, ["customerPrompt"])).toThrow(/customerPrompt: no field rule/);
  });

  it("explains rewritten routes and undeclared events", () => {
    const { dropped } = explainTelemetry({ log: "my.new.event", context: { route: "/api/customer/acme", method: "GET" } });
    expect(dropped.event).toMatch(/not in RequestEventMap or SystemEventMap.*log\.unknown/);
    expect(dropped.route).toMatch(/rewritten to "unknown_route"/);
    expect(() =>
      expectTelemetryFields({ log: "http.request.failed", context: { route: "/api/customer/acme", method: "GET" } }, ["route"]),
    ).toThrow(/route: rewritten to "unknown_route"/);
    expect(() => expectTelemetryFields({ log: "http.request.failed", context: { statusCode: undefined } }, ["statusCode"])).toThrow();
  });
});

describe("explainTelemetry: server analytics", () => {
  it("forwards enum, boolean and number properties and explains each drop", () => {
    const sample = {
      analytics: "api_agent_turn_completed",
      actorId: USER,
      properties: { outcome: "ok", duration_ms: 950, deduped: "yes", server_url: "https://acme.example" },
    };
    const { forwarded, dropped } = explainTelemetry(sample);
    expect(forwarded).toEqual({ event: "api_agent_turn_completed", outcome: "ok", duration_ms: 950 });
    expect(dropped.deduped).toBe("expects a boolean, got string");
    expect(dropped.server_url).toMatch(/no field rule: declare it in shared\/strict-server-analytics\.ts/);
    expect(() => expectTelemetryFields(sample, ["server_url"])).toThrow(/server_url: no field rule/);
    expect(explainTelemetry({ ...sample, properties: { outcome: 1n } }).dropped.outcome).toMatch(/^1 is not an allowed value/);
  });

  it("explains Object.prototype member names as fields without a rule", () => {
    const log = explainTelemetry({
      log: "http.request.failed",
      context: { toString: "x", constructor: "ok" },
    });
    expect(log.dropped.toString).toMatch(/^no field rule/);
    expect(log.dropped.constructor).toMatch(/^no field rule/);
    const analytics = explainTelemetry({
      analytics: "api_agent_turn_completed",
      actorId: USER,
      properties: { constructor: "ok" },
    });
    expect(analytics.dropped.constructor).toMatch(/^no field rule/);
    expect(
      explainTelemetry({
        analytics: "constructor",
        actorId: USER,
        properties: {},
      }).dropped.event,
    ).toMatch(/is not declared/);
  });

  it("says why a whole event is not sent", () => {
    expect(explainTelemetry({ analytics: "made_up_event", actorId: USER, properties: { outcome: "ok" } }).dropped).toEqual({
      event: '"made_up_event" is not declared with source "server" in shared/analytics-events.ts, so nothing is sent',
      outcome: "the event was not sent",
    });
  });
});
