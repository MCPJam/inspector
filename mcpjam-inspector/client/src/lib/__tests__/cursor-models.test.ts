import { describe, expect, it } from "vitest";
import { cursorModelRows } from "../cursor-models";
import {
  harnessPickerModels,
  harnessDefaultModel,
} from "../harness-model-locks";

describe("Cursor account model rows", () => {
  const catalog = {
    configured: true,
    models: [
      { modelId: "cursor/mini", displayName: "Mini" },
      { modelId: "cursor/old", displayName: "Old", retiredAt: 1 },
    ],
  };
  it("puts Auto first and retains retired or missing saved choices as disabled", () => {
    const rows = cursorModelRows(catalog, ["cursor/missing"]);
    expect(rows[0]).toMatchObject({
      id: "cursor/auto",
      name: "Cursor Auto",
      hosted: false,
    });
    expect(rows.find((r) => r.id === "cursor/old")?.disabled).toBe(true);
    expect(rows.find((r) => r.id === "cursor/missing")?.disabled).toBe(true);
    expect(rows.find((r) => r.id === "cursor/mini")?.disabled).toBeUndefined();
  });
  it("never falls back to another provider while loading or after key removal", () => {
    for (const value of [undefined, { configured: false, models: [] }]) {
      const rows = cursorModelRows(value, ["cursor/mini"]);
      expect(rows.every((row) => row.disabled)).toBe(true);
      expect(
        harnessDefaultModel(rows, { harnessId: "cursor" }),
      ).toBeUndefined();
    }
  });
  it("offers only account rows for Cursor and prefers Auto", () => {
    const rows = harnessPickerModels(
      [
        {
          id: "openai/gpt-mini",
          name: "Other",
          provider: "openai",
          hosted: true,
        },
        ...cursorModelRows(catalog),
      ],
      { harnessId: "cursor" },
    );
    expect(rows.every((row) => row.provider === "cursor")).toBe(true);
    expect(harnessDefaultModel(rows, { harnessId: "cursor" })?.id).toBe(
      "cursor/auto",
    );
    expect(
      harnessDefaultModel(rows, { harnessId: "cursor" }, "cursor/mini")?.id,
    ).toBe("cursor/mini");
  });
  it("does not replace a retired client model with Auto", () => {
    const rows = cursorModelRows(catalog);
    expect(
      harnessDefaultModel(rows, { harnessId: "cursor" }, "cursor/old"),
    ).toMatchObject({ id: "cursor/old", disabled: true });
  });
});
