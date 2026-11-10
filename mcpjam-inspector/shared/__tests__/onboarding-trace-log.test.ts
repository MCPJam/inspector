import { describe, expect, it } from "vitest";
import { sha256Hex } from "@mcpjam/sdk/contract";
import { buildLegacyLogRow, buildStrictLogRow } from "../strict-log.js";
import { ONBOARDING_TURN_PHASES } from "../onboarding-trace.js";

const attemptId = "11111111-1111-4111-8111-111111111111";
const pluginVersionId = "rn7gvrtpgmb9ygrtxfw99b18jh8hjegv";
const identity = { attemptId, pluginVersionId };
const hashes = {
  onboardingAttemptHash: sha256Hex(`plugin.onboarding.attempt:${attemptId}`),
  onboardingVersionHash: sha256Hex(`plugin.onboarding.version:${pluginVersionId}`),
};
const sentinel = "PRIVATE_SENTINEL";

function row(event: string, payload: Record<string, unknown>) {
  return buildStrictLogRow(event, {}, payload);
}

describe("serialized onboarding traces", () => {
  it.each(["plugin.onboarding.turn", "plugin.onboarding.turn.stalled"])(
    "keeps bounded correlation and phase timings on %s",
    (event) => {
      const phases = Object.fromEntries(ONBOARDING_TURN_PHASES.map((phase, i) => [phase, i]));
      const result = row(event, { ...identity, phases });
      expect(result).toMatchObject({ ...hashes, phases });
      expect(JSON.stringify(result)).not.toContain(attemptId);
      expect(JSON.stringify(result)).not.toContain(pluginVersionId);
    },
  );

  it("keeps the last known phase and bounded terminal codes", () => {
    for (const lastPhase of ["received", ...ONBOARDING_TURN_PHASES])
      expect(row("plugin.onboarding.turn.stalled", { lastPhase })).toMatchObject({ lastPhase });
    for (const code of ["stream_error", "ended_without_finish", "http_401", "http_500"])
      expect(row("plugin.onboarding.turn", { code })).toMatchObject({ code });
  });

  it("drops unbounded identifiers, prose and unknown phase fields", () => {
    const result = row("plugin.onboarding.turn.stalled", {
      attemptId: sentinel, pluginVersionId: sentinel, lastPhase: sentinel,
      phases: { admission: 0, [sentinel]: sentinel },
      skill: sentinel, arguments: { secret: sentinel },
    });
    expect(result).toMatchObject({ phases: { admission: 0 } });
    for (const key of ["attemptId", "pluginVersionId", "onboardingAttemptHash", "onboardingVersionHash", "lastPhase", "skill", "arguments"])
      expect(result).not.toHaveProperty(key);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("hashes a well-shaped body value without treating it as a verified ID", () => {
    const supplied = "privatesentinel".padEnd(32, "0");
    const result = row("plugin.onboarding.turn", { pluginVersionId: supplied });
    expect(result.onboardingVersionHash)
      .toBe(sha256Hex(`plugin.onboarding.version:${supplied}`));
    expect(JSON.stringify(result)).not.toContain(supplied);
    expect(result).not.toHaveProperty("pluginVersionId");
    expect(row("plugin.onboarding.turn", hashes)).not.toHaveProperty("onboardingVersionHash");
  });

  it.each([NaN, Infinity, -1, 0.5, 86_400_001, "12", true, null, {}])(
    "drops a phase time outside finite whole elapsed milliseconds: %s",
    (value) => {
      expect(row("plugin.onboarding.turn", { phases: { admission: value } }))
        .not.toHaveProperty("phases");
    },
  );

  it("does not copy inherited phases, accessors or arrays", () => {
    const phases = Object.create({ admission: 0 });
    Object.defineProperty(phases, "tools", { get() { throw new Error("Do not read arbitrary accessors"); } });
    expect(row("plugin.onboarding.turn", { phases })).not.toHaveProperty("phases");
    expect(row("plugin.onboarding.turn", { phases: [0, 1] })).not.toHaveProperty("phases");
  });

  it("does not widen other events, legacy rows or request context", () => {
    const payload = { ...identity, phases: { admission: 0 }, lastPhase: "received", code: "stream_error" };
    for (const event of ["http.request.completed", "log.unknown"])
      for (const key of Object.keys(payload)) expect(row(event, payload)).not.toHaveProperty(key);
    const contextOnly = buildStrictLogRow("plugin.onboarding.turn", payload);
    for (const key of Object.keys(payload)) expect(contextOnly).not.toHaveProperty(key);
    const legacy = buildLegacyLogRow("[harness][timing] claim=1ms", payload);
    for (const key of Object.keys(payload)) expect(legacy).not.toHaveProperty(key);
    for (const key of Object.keys(hashes)) {
      expect(row("http.request.completed", payload)).not.toHaveProperty(key);
      expect(contextOnly).not.toHaveProperty(key);
      expect(legacy).not.toHaveProperty(key);
    }
  });

  it("keeps only event-appropriate bounded fields", () => {
    expect(row("plugin.onboarding.turn", { lastPhase: "connection" })).not.toHaveProperty("lastPhase");
    expect(row("plugin.onboarding.turn.stalled", { code: "stream_error" })).not.toHaveProperty("code");
    for (const code of [sentinel, "http_099", "http_600", "http_500 private"])
      expect(row("plugin.onboarding.turn", { code })).not.toHaveProperty("code");
  });
});
