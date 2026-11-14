import { describe, expect, it } from "vitest";
import {
  HARNESS_TURN_BOOTSTRAPS,
  HARNESS_TURN_DURATIONS,
  HARNESS_TURN_FALLBACK_REASONS,
  HARNESS_TURN_KINDS,
  HARNESS_TURN_OUTCOMES,
  HARNESS_TURN_STARTS,
  HARNESS_TURN_SURFACES,
} from "../harness-turn-event";
import { rebuildServerAnalytics } from "../strict-server-analytics";
import { explainTelemetry, expectTelemetryFields } from "./explain-telemetry";

/**
 * `harness_turn_completed` crosses the strict server analytics boundary, which
 * forwards only declared fields: every value its vocabulary lists has to
 * arrive, and anything else has to be dropped.
 */
const USER = "user_01HZ0000000000000000000000";
const ORG = "k57d2gqxm9vbhw4e3n8r6tyf1c0sa2jz";

const forwarded = (properties: Record<string, unknown>) =>
  rebuildServerAnalytics("harness_turn_completed", USER, properties)
    ?.properties;

describe("harness_turn_completed at the strict analytics boundary", () => {
  it.each([
    ["surface", HARNESS_TURN_SURFACES],
    ["kind", HARNESS_TURN_KINDS],
    ["start", HARNESS_TURN_STARTS],
    ["fallback_reason", HARNESS_TURN_FALLBACK_REASONS],
    ["bootstrap", HARNESS_TURN_BOOTSTRAPS],
    ["outcome", HARNESS_TURN_OUTCOMES],
  ] as const)("forwards every %s value", (field, values) => {
    for (const value of values) {
      expect(forwarded({ [field]: value })).toEqual({ [field]: value });
    }
    expect(forwarded({ [field]: "something-else" })).toEqual({});
  });

  it("forwards a first message on a box prepared before Send", () => {
    expect(forwarded({ kind: "first", start: "prepared" })).toEqual({
      kind: "first",
      start: "prepared",
    });
  });

  it.each(HARNESS_TURN_DURATIONS)(
    "forwards %s as whole milliseconds only",
    (field) => {
      expect(forwarded({ [field]: 1_250 })).toEqual({ [field]: 1_250 });
      expect(forwarded({ [field]: 1.5 })).toEqual({});
      expect(forwarded({ [field]: -5 })).toEqual({});
      expect(forwarded({ [field]: "1250" })).toEqual({});
    },
  );

  it("drops a fraction of a millisecond, and leaves other numbers as they were", () => {
    expect(forwarded({ first_text_ms: 1.5 })).toEqual({});
    expect(forwarded({ first_text_ms: 1500 })).toEqual({ first_text_ms: 1500 });
    expect(
      explainTelemetry({
        analytics: "harness_turn_completed",
        actorId: USER,
        properties: { first_text_ms: 1.5 },
      }).dropped.first_text_ms,
    ).toBe("expects a whole number from 0 to 86400000, got 1.5");
    expect(
      rebuildServerAnalytics("api_chat_session_turn_completed", USER, {
        duration_ms: 1.5,
      })?.properties,
    ).toEqual({ duration_ms: 1.5 });
  });

  it("forwards a whole event, organization included", () => {
    const event = {
      surface: "api",
      harness_id: "codex",
      outcome: "completed",
      bootstrap: "baked",
      kind: "follow_up",
      start: "disk_resume",
      fallback_reason: "probe_refused",
      first_text_ms: 4_210,
      claim_ms: 290,
      box_wake_ms: 1_310,
      broker_start_ms: 1_220,
      session_connect_ms: 410,
      dispatch_setup_ms: 3_400,
      model_stream_ms: 2_100,
      organization_id: ORG,
    };
    const sample = {
      analytics: "harness_turn_completed",
      actorId: USER,
      properties: event,
    };
    expect(expectTelemetryFields(sample, Object.keys(event))).toEqual({
      event: "harness_turn_completed",
      ...event,
    });
  });

  it("keeps an organization only in a Convex ID's shape, and drops content", () => {
    const { forwarded: kept, dropped } = explainTelemetry({
      analytics: "harness_turn_completed",
      actorId: USER,
      properties: {
        outcome: "failed",
        organization_id: "https://acme.example/orgs/1",
        error_message: "sandbox sbx_9f2c41d7 refused",
        sandbox_id: "sbx_9f2c41d7",
        prompt: "summarize my private doc",
      },
    });
    expect(kept).toEqual({
      event: "harness_turn_completed",
      outcome: "failed",
    });
    expect(Object.keys(dropped).sort()).toEqual([
      "error_message",
      "organization_id",
      "prompt",
      "sandbox_id",
    ]);
  });
});
