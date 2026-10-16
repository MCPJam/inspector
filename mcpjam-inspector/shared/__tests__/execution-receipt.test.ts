import { describe, expect, it } from "vitest";
import { executionReceipt, executionReceiptSchema } from "../execution-receipt";

describe("execution receipts", () => {
  it("identifies emulated execution without claiming a harness version", () => {
    expect(executionReceipt(undefined, "emulated", "session", "turn")).toEqual({
      engine: "emulated",
      venue: "hosted",
      runtimeVersion: null,
      sessionId: "session",
      turnId: "turn",
    });
  });
  it.each(["hosted", "local-native"] as const)(
    "preserves the runtime's %s evidence",
    (venue) => {
      expect(
        executionReceipt(
          { engine: "harness:codex", venue, runtimeVersion: "0.99.0" },
          "harness:codex",
          "session",
          "turn",
        ),
      ).toMatchObject({ venue, runtimeVersion: "0.99.0" });
    },
  );
  it("refuses to invent a receipt from a requested harness", () => {
    expect(() =>
      executionReceipt(undefined, "harness:codex", "session", "turn"),
    ).toThrow(/receipt/);
  });
  it.each([
    { engine: "harness:codex", venue: "desktop", runtimeVersion: "1" },
    { engine: "harness:codex", venue: "local-native", runtimeVersion: "" },
    { engine: "requested:codex", venue: "hosted", runtimeVersion: "1" },
  ])("rejects invalid runtime evidence %j", (runtime) => {
    expect(
      executionReceiptSchema.safeParse({
        ...runtime,
        sessionId: "session",
        turnId: "turn",
      }).success,
    ).toBe(false);
  });
});
