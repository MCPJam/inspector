import { describe, expect, it } from "vitest";
import {
  extractStyleVariables,
  isColorToken,
  parseTokenValue,
} from "../parse";

describe("parseTokenValue", () => {
  it("splits light-dark with nested rgba arguments", () => {
    const parsed = parseTokenValue(
      "light-dark(rgba(255, 255, 255, 1), rgba(48, 48, 46, 1))",
    );
    expect(parsed).toEqual({
      kind: "light-dark",
      light: "rgba(255, 255, 255, 1)",
      dark: "rgba(48, 48, 46, 1)",
      raw: "light-dark(rgba(255, 255, 255, 1), rgba(48, 48, 46, 1))",
    });
  });

  it("passes through solid values", () => {
    expect(parseTokenValue("10px")).toEqual({
      kind: "solid",
      value: "10px",
      raw: "10px",
    });
  });
});

describe("extractStyleVariables", () => {
  it("reads hostContext.styles.variables strings", () => {
    expect(
      extractStyleVariables({
        styles: {
          variables: {
            "--color-text-primary": "light-dark(#111, #eee)",
            "--skip": 12,
          },
        },
      }),
    ).toEqual({
      "--color-text-primary": "light-dark(#111, #eee)",
    });
  });

  it("returns null when variables are missing", () => {
    expect(extractStyleVariables({ theme: "light" })).toBeNull();
    expect(extractStyleVariables({ styles: { variables: {} } })).toBeNull();
  });
});

describe("isColorToken", () => {
  it("treats --color-* and color functions as color", () => {
    expect(isColorToken("--color-text-primary", "10px")).toBe(true);
    expect(isColorToken("--shadow-sm", "oklch(0.2 0 0)")).toBe(true);
    expect(isColorToken("--font-sans", "Anthropic Sans, sans-serif")).toBe(
      false,
    );
  });
});
