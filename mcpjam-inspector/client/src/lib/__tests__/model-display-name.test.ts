import { describe, expect, it } from "vitest";
import { modelDisplayName } from "../model-display-name";

describe("modelDisplayName", () => {
  it("ignores synthetic SDK provider labels", () => {
    expect(modelDisplayName("external/gpt-5")).toBe("GPT-5");
    expect(modelDisplayName("external/n/a")).toBe("n/a");
    expect(
      modelDisplayName("external/custom/my-model", [
        { id: "custom/my-model", name: "Custom" },
      ]),
    ).toBe("Custom");
  });
  it.each([
    "claude-haiku-4-5-20251001",
    "anthropic/claude-haiku-4.5",
    "mcpjam/anthropic/claude-haiku-4.5",
  ])("uses the catalog name for %s", (id) =>
    expect(modelDisplayName(id)).toBe("Claude Haiku 4.5"),
  );
  it("uses configured names and leaves unknown identifiers intact", () => {
    expect(
      modelDisplayName("custom/my-model", [
        { id: "custom/my-model", name: "My Model" },
      ]),
    ).toBe("My Model");
    expect(modelDisplayName("unknown/my-20260101")).toBe("unknown/my-20260101");
    expect(modelDisplayName("custom/claude-haiku-4.5")).toBe(
      "custom/claude-haiku-4.5",
    );
    expect(modelDisplayName("—")).toBe("—");
  });
});
