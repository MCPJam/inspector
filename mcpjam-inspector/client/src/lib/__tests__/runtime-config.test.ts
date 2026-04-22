import { beforeEach, describe, expect, it } from "vitest";
import {
  getRuntimeConvexSiteUrl,
  getRuntimeConvexUrl,
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
});
