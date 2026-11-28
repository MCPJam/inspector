import { describe, expect, it } from "vitest";
import { resolveComparePaneTheme } from "../compare-pane-theme";

describe("resolveComparePaneTheme", () => {
  it.each([
    { app: "dark", seeded: "light" },
    { app: "light", seeded: "dark" },
  ] as const)(
    "uses $app for an untouched starter seeded with $seeded",
    ({ app, seeded }) => {
      const hostContext = { theme: seeded };
      expect(resolveComparePaneTheme(app, undefined, hostContext, true)).toEqual(
        { choice: "app", theme: app, clientTheme: undefined },
      );
      expect(resolveComparePaneTheme(app, seeded, hostContext, true)).toMatchObject(
        { choice: seeded, theme: seeded },
      );
    },
  );

  it("preserves saved themes unless a pane explicitly switches away", () => {
    const hostContext = { theme: "light" };
    expect(resolveComparePaneTheme("dark", undefined, hostContext)).toEqual({
      choice: "client",
      theme: "light",
      clientTheme: "light",
    });
    expect(
      resolveComparePaneTheme("dark", "app", hostContext, false),
    ).toMatchObject({ choice: "app", theme: "dark" });
    expect(
      resolveComparePaneTheme("dark", "client", hostContext, false),
    ).toMatchObject({ choice: "client", theme: "light" });
  });
});
