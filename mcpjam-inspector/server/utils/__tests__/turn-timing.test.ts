import { describe, expect, it } from "vitest";
import { TurnTiming } from "../turn-timing.js";

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

  it("reports nothing before any stage closes", () => {
    const timing = new TurnTiming(clock(5));
    expect(timing.serverTiming()).toBe("");
    expect(timing.fields()).toEqual({});
    expect(timing.text()).toBe("");
  });
});
