import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { tokensCss } from "../tokens";

describe("tokens parity", () => {
  it("keeps tokens.ts in sync with tokens.css", () => {
    const cssFromFile = readFileSync(
      new URL("../tokens.css", import.meta.url),
      "utf8",
    );

    expect(tokensCss).toBe(cssFromFile);
  });
});
