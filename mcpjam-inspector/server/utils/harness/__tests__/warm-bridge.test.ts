import { describe, expect, it } from "vitest";
import { processBirthIdentity } from "../warm-bridge.js";

describe("Linux process birth identity", () => {
  it("handles spaces and closing parentheses inside the process name", () => {
    const fields = [
      "S",
      ...Array.from({ length: 18 }, () => "0"),
      "12345",
      "0",
    ];
    expect(
      processBirthIdentity(`42 (node worker) (main)) ${fields.join(" ")}`),
    ).toBe("12345");
  });

  it.each(["", "42 node S", "42 (node) S 0", "42 (node) S invalid"])(
    "refuses incomplete stat data",
    (stat) => {
      expect(processBirthIdentity(stat)).toBeUndefined();
    },
  );
});
