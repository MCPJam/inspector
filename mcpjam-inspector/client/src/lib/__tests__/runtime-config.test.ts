import { beforeEach, describe, expect, it } from "vitest";
import {
  getRuntimeAllowPrivateOAuthTargets,
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
    expect(getRuntimeAllowPrivateOAuthTargets()).toBe(false);
  });

  it("returns injected convex urls when present", () => {
    (window as any).__MCP_RUNTIME_CONFIG__ = {
      convexUrl: "https://runtime.convex.cloud",
      convexSiteUrl: "https://runtime.convex.site",
    };

    expect(getRuntimeConvexUrl()).toBe("https://runtime.convex.cloud");
    expect(getRuntimeConvexSiteUrl()).toBe("https://runtime.convex.site");
  });

  it("enables private OAuth targets only for an injected boolean true", () => {
    (window as any).__MCP_RUNTIME_CONFIG__ = {
      allowPrivateOAuthTargets: true,
    };
    expect(getRuntimeAllowPrivateOAuthTargets()).toBe(true);

    (window as any).__MCP_RUNTIME_CONFIG__ = {
      allowPrivateOAuthTargets: "true",
    };
    expect(getRuntimeAllowPrivateOAuthTargets()).toBe(false);
  });
});
