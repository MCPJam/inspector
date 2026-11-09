import { describe, expect, it } from "vitest";
import { buildLegacyLogRow } from "../../../shared/strict-log.js";
import { TURN_TIMING_STAGES, TurnTiming } from "../turn-timing.js";

function clock(...readings: number[]) {
  let index = 0;
  return () => readings[Math.min(index++, readings.length - 1)]!;
}

describe("TurnTiming", () => {
  it("measures each stage from the previous mark", () => {
    const timing = new TurnTiming(clock(1000, 1012.4, 1015, 1415.06));
    timing.mark("setup");
    timing.mark("turnAuthorization");
    timing.mark("tools");
    expect(timing.fields()).toEqual({
      setupMs: 12,
      turnAuthorizationMs: 3,
      toolsMs: 400,
    });
    expect(timing.serverTiming()).toBe(
      "setup;dur=12.4, turnAuthorization;dur=2.6, tools;dur=400.1",
    );
  });

  it("keeps the first text, measured from the start of the turn", () => {
    const timing = new TurnTiming(clock(0, 50, 3200, 3900));
    timing.mark("setup");
    timing.markFirstText();
    timing.markFirstText();
    expect(timing.fields()).toEqual({ setupMs: 50, firstTextMs: 3200 });
    expect(timing.text()).toBe(" setupMs=50 firstTextMs=3200");
  });

  it("keeps every field in the production log row", () => {
    const timing = new TurnTiming(clock(0, 10, 20, 30, 40, 50, 60));
    for (const stage of TURN_TIMING_STAGES) timing.mark(stage);
    timing.markFirstText();
    const fields = timing.fields();
    expect(Object.keys(fields)).toHaveLength(TURN_TIMING_STAGES.length + 1);
    expect(
      buildLegacyLogRow("[harness][timing] claim=1ms", fields),
    ).toMatchObject({ event: "harness.timing", ...fields });
  });

  it("reports nothing before any stage closes", () => {
    const timing = new TurnTiming(clock(5));
    expect(timing.serverTiming()).toBe("");
    expect(timing.fields()).toEqual({});
    expect(timing.text()).toBe("");
  });
});
