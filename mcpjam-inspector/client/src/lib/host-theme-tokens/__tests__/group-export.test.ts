import { describe, expect, it } from "vitest";
import { exportStyleVariablesCss, exportStyleVariablesJson } from "../export";
import { categoryForToken, groupStyleVariables } from "../group";

describe("categoryForToken", () => {
  it("maps SEP-1865 prefixes", () => {
    expect(categoryForToken("--color-background-primary")).toBe("background");
    expect(categoryForToken("--color-text-danger")).toBe("text");
    expect(categoryForToken("--font-sans")).toBe("typography");
    expect(categoryForToken("--border-radius-lg")).toBe("radius");
    expect(categoryForToken("--shadow-md")).toBe("shadow");
    expect(categoryForToken("--mystery")).toBe("other");
  });
});

describe("groupStyleVariables", () => {
  it("keeps category order and drops empty groups", () => {
    const groups = groupStyleVariables({
      "--font-sans": "system-ui",
      "--color-background-primary": "#fff",
    });
    expect(groups.map((g) => g.category)).toEqual(["background", "typography"]);
  });
});

describe("export", () => {
  const variables = { "--border-radius-lg": "10px" };

  it("emits a :root CSS block", () => {
    expect(exportStyleVariablesCss(variables)).toBe(
      ":root {\n  --border-radius-lg: 10px;\n}\n",
    );
  });

  it("emits pretty JSON", () => {
    expect(exportStyleVariablesJson(variables)).toBe(
      '{\n  "--border-radius-lg": "10px"\n}\n',
    );
  });
});
