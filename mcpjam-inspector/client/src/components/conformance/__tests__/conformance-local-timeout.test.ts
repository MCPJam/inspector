import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readLocalTimeout,
  saveLocalTimeout,
  readSessionTimeout,
  saveSessionTimeout,
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

describe("project session conformance timeout", () => {
  beforeEach(() => window.sessionStorage.clear());
  it("isolates projects and servers, including delimiter-like names", () => {
    saveSessionTimeout("project-a", "alpha", 90);
    saveSessionTimeout("project-b", "alpha", 120);
    saveSessionTimeout("project-a", "beta", 30);
    saveSessionTimeout("a:b", "c", 1);
    saveSessionTimeout("a", "b:c", 2);
    expect(readSessionTimeout("project-a", "alpha")).toBe(90);
    expect(readSessionTimeout("project-b", "alpha")).toBe(120);
    expect(readSessionTimeout("project-a", "beta")).toBe(30);
    expect(readSessionTimeout("a:b", "c")).toBe(1);
    expect(readSessionTimeout("a", "b:c")).toBe(2);
  });
  it("clears only the chosen project/server", () => {
    saveSessionTimeout("project-a", "alpha", 90);
    saveSessionTimeout("project-b", "alpha", 120);
    saveSessionTimeout("project-a", "alpha", null);
    expect(readSessionTimeout("project-a", "alpha")).toBeUndefined();
    expect(readSessionTimeout("project-b", "alpha")).toBe(120);
  });
});
