import { describe, expect, it } from "vitest";
import { isModuleLoadError } from "../module-load-error";

describe("isModuleLoadError", () => {
  it.each([
    "Failed to fetch dynamically imported module: https://app.mcpjam.com/assets/trace-timeline-old.js",
    "error loading dynamically imported module: https://app.mcpjam.com/assets/trace-timeline-old.js",
    "Importing a module script failed.",
  ])("recognizes a module import failure: %s", (message) => {
    expect(isModuleLoadError(new TypeError(message))).toBe(true);
    expect(isModuleLoadError(`TypeError: ${message}`)).toBe(true);
  });

  it.each([
    null,
    undefined,
    {},
    { message: 42 },
    new TypeError("Failed to fetch"),
    new Error("Cannot read properties of undefined"),
    new Error("Server Error: error loading dynamically imported module: test"),
  ])("does not treat another failure as a module import: %s", (error) => {
    expect(isModuleLoadError(error)).toBe(false);
  });
});
