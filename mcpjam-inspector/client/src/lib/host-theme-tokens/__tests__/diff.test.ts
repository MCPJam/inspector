import { describe, expect, it } from "vitest";
import { diffChangeCount, diffStyleVariables, summarizeTokenDiff } from "../diff";

describe("diffStyleVariables", () => {
  it("reports added, removed, and changed tokens", () => {
    expect(
      diffStyleVariables(
        {
          "--keep": "1",
          "--gone": "x",
          "--color-text-primary": "old",
        },
        {
          "--keep": "1",
          "--new": "y",
          "--color-text-primary": "new",
        },
      ),
    ).toEqual({
      added: [{ name: "--new", value: "y" }],
      removed: [{ name: "--gone", value: "x" }],
      changed: [
        { name: "--color-text-primary", from: "old", to: "new" },
      ],
    });
  });

  it("returns empty buckets when maps match", () => {
    const vars = { "--a": "1" };
    expect(diffStyleVariables(vars, vars)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    expect(diffChangeCount(diffStyleVariables(vars, vars))).toBe(0);
  });
});

describe("summarizeTokenDiff", () => {
  it("counts color and radius names", () => {
    expect(
      summarizeTokenDiff({
        added: [{ name: "--color-background-accent", value: "x" }],
        removed: [],
        changed: [
          { name: "--border-radius-lg", from: "8px", to: "10px" },
          { name: "--font-sans", from: "a", to: "b" },
        ],
      }),
    ).toEqual({ colors: 1, radius: 1, other: 1 });
  });
});
