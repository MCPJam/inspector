import { beforeEach, describe, expect, it } from "vitest";
import {
  getRuntimeConvexSiteUrl,
  getRuntimeConvexUrl,
  getRuntimeDoNotTrack,
} from "../runtime-config";

describe("runtime-config", () => {
  beforeEach(() => {
    delete (window as any).__MCP_RUNTIME_CONFIG__;
  });

  it("returns undefined when no runtime config was injected", () => {
    expect(getRuntimeConvexUrl()).toBeUndefined();
    expect(getRuntimeConvexSiteUrl()).toBeUndefined();
  });

  it("returns injected convex urls when present", () => {
    (window as any).__MCP_RUNTIME_CONFIG__ = {
      convexUrl: "https://runtime.convex.cloud",
      convexSiteUrl: "https://runtime.convex.site",
    };

    expect(getRuntimeConvexUrl()).toBe("https://runtime.convex.cloud");
    expect(getRuntimeConvexSiteUrl()).toBe("https://runtime.convex.site");
  });

  it("reads DO_NOT_TRACK only as the literal true the server serves", () => {
    expect(getRuntimeDoNotTrack()).toBe(false);
    // A document can carry anything; only the boolean the server writes counts.
    Object.assign(window, { __MCP_RUNTIME_CONFIG__: { doNotTrack: "true" } });
    expect(getRuntimeDoNotTrack()).toBe(false);
    window.__MCP_RUNTIME_CONFIG__ = { doNotTrack: true };
    expect(getRuntimeDoNotTrack()).toBe(true);
  });
});
