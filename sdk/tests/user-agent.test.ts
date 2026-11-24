import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getDefaultUserAgent,
  mcpjamUserAgent,
  setDefaultUserAgent,
} from "../src/user-agent.js";

const SLOT = Symbol.for("mcpjam.defaultUserAgent");

afterEach(() => {
  Reflect.deleteProperty(globalThis, SLOT);
});

describe("mcpjamUserAgent", () => {
  it("names MCPJam and its version, and keeps the old token at the end", () => {
    expect(mcpjamUserAgent("3.24.0")).toBe(
      "MCPJam/3.24.0 (+https://mcpjam.com) MCP-Inspector/1.0",
    );
  });
});

describe("the default User-Agent", () => {
  it("uses the SDK's own version until an app sets one", () => {
    expect(getDefaultUserAgent()).toMatch(
      /^MCPJam\/(unknown|\d+\.\d+\.\d+\S*) \(\+https:\/\/mcpjam\.com\) MCP-Inspector\/1\.0$/,
    );
  });

  it("returns the value an app set", () => {
    setDefaultUserAgent(mcpjamUserAgent("3.24.0"));

    expect(getDefaultUserAgent()).toBe(
      "MCPJam/3.24.0 (+https://mcpjam.com) MCP-Inspector/1.0",
    );
  });

  it("is shared by every copy of the module, since each SDK entry bundles its own", async () => {
    vi.resetModules();
    const first = await import("../src/user-agent.js");
    vi.resetModules();
    const second = await import("../src/user-agent.js");
    expect(second).not.toBe(first);

    first.setDefaultUserAgent("set-through-one-copy/1.0");

    expect(second.getDefaultUserAgent()).toBe("set-through-one-copy/1.0");
  });
});
