import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readLocalTimeout,
  saveLocalTimeout,
} from "../conformance-local-timeout";

describe("local conformance timeout", () => {
  beforeEach(() => window.localStorage.clear());
  it("remembers each server independently and clears a saved value", () => {
    saveLocalTimeout("alpha", 300);
    saveLocalTimeout("beta", 1);
    expect(readLocalTimeout("alpha")).toBe(300);
    expect(readLocalTimeout("beta")).toBe(1);
    saveLocalTimeout("alpha", null);
    expect(readLocalTimeout("alpha")).toBeUndefined();
    expect(readLocalTimeout("beta")).toBe(1);
  });
  it("ignores invalid stored values", () => {
    window.localStorage.setItem("mcpjam:conformance:timeout:alpha", "301");
    expect(readLocalTimeout("alpha")).toBeUndefined();
  });
  it("reports failed writes to the caller", () => {
    const spy = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("storage blocked");
      });
    expect(() => saveLocalTimeout("alpha", 30)).toThrow("storage blocked");
    spy.mockRestore();
  });
});
