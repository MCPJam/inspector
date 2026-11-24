import { describe, expect, it } from "vitest";
import { bindMockRun, registerMockRunSlot, type MockRunSlot } from "../mock-run.js";

describe("the run a manager's mock connections serve", () => {
  it("tells the slot a manager registered, and only that manager's", () => {
    const [one, two] = [{}, {}];
    const slots: MockRunSlot[] = [{}, {}];
    registerMockRunSlot(one, slots[0]!);
    registerMockRunSlot(two, slots[1]!);
    bindMockRun(one, "run-1");
    expect(slots.map((slot) => slot.key)).toEqual(["run-1", undefined]);
  });

  it("leaves a run the dialer already named, and ignores a manager with no slot", () => {
    const manager = {};
    const slot: MockRunSlot = { key: "token-run" };
    registerMockRunSlot(manager, slot);
    bindMockRun(manager, "run-2");
    expect(slot.key).toBe("token-run");
    expect(() => bindMockRun({}, "run-3")).not.toThrow();
  });
});
