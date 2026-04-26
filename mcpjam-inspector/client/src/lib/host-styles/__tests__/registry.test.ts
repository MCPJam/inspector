import { describe, expect, it, vi } from "vitest";
import {
  CHATGPT_HOST_STYLE,
  CLAUDE_HOST_STYLE,
  DEFAULT_HOST_STYLE,
  findHostStyle,
  getHostStyleOrDefault,
  isKnownHostStyleId,
  listHostStyles,
  registerHostStyle,
  type HostStyleDefinition,
} from "..";

describe("host-styles registry", () => {
  it("registers built-in claude and chatgpt hosts by id", () => {
    expect(findHostStyle("claude")).toBe(CLAUDE_HOST_STYLE);
    expect(findHostStyle("chatgpt")).toBe(CHATGPT_HOST_STYLE);
  });

  it("returns undefined for unknown ids", () => {
    expect(findHostStyle("does-not-exist")).toBeUndefined();
    expect(findHostStyle(null)).toBeUndefined();
    expect(findHostStyle(undefined)).toBeUndefined();
  });

  it("falls back to claude when an id is unknown or absent", () => {
    expect(DEFAULT_HOST_STYLE).toBe(CLAUDE_HOST_STYLE);
    expect(getHostStyleOrDefault(null)).toBe(CLAUDE_HOST_STYLE);
    expect(getHostStyleOrDefault("missing")).toBe(CLAUDE_HOST_STYLE);
    expect(getHostStyleOrDefault("chatgpt")).toBe(CHATGPT_HOST_STYLE);
  });

  it("recognises only registered ids via the type guard", () => {
    expect(isKnownHostStyleId("claude")).toBe(true);
    expect(isKnownHostStyleId("chatgpt")).toBe(true);
    expect(isKnownHostStyleId("unknown")).toBe(false);
    expect(isKnownHostStyleId(42)).toBe(false);
    expect(isKnownHostStyleId(null)).toBe(false);
  });

  it("includes the built-ins in listHostStyles in registration order", () => {
    const ids = listHostStyles().map((host) => host.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("chatgpt");
    expect(ids.indexOf("claude")).toBeLessThan(ids.indexOf("chatgpt"));
  });

  it("registers custom host styles for workspace-defined hosts", () => {
    const fakeStyle: HostStyleDefinition = {
      id: "test-host-registry",
      label: "Test Host",
      shortLabel: "Test-style host",
      pickerDescription: "Test chrome",
      logoSrc: "/test-logo.png",
      family: "claude",
      protocolOverride: CLAUDE_HOST_STYLE.protocolOverride,
      platform: "web",
      fontCss: "",
      resolveStyleVariables: CLAUDE_HOST_STYLE.resolveStyleVariables,
      resolveChatBackground: () => "rgba(0, 0, 0, 1)",
    };

    registerHostStyle(fakeStyle);

    expect(findHostStyle("test-host-registry")).toBe(fakeStyle);
    expect(isKnownHostStyleId("test-host-registry")).toBe(true);
    expect(listHostStyles()).toContain(fakeStyle);
  });

  it("rejects duplicate host style ids", async () => {
    vi.resetModules();
    const { CLAUDE_HOST_STYLE, registerHostStyle } = await import("..");

    expect(() => registerHostStyle(CLAUDE_HOST_STYLE)).toThrow(
      /already registered/,
    );
  });
});
