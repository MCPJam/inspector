import { describe, expect, it } from "vitest";
import {
  emulatedServerPluginId,
  isPluginDeepLink,
  localPluginDeepLink,
  parsePluginDeepLink,
  pluginDeepLinkMatchesRuntime,
} from "../plugin-deep-link";

describe("closed plugin deep links", () => {
  it.each([
    ["codex", "codex", true],
    ["codex", "chatgpt", false],
    ["chatgpt", "codex", false],
    ["chatgpt", "chatgpt", true],
    ["https", "codex", false],
    ["https", "chatgpt", true],
  ] as const)(
    "qualifies %s only for supported %s runtime",
    (scheme, runtime, allowed) => {
      expect(
        pluginDeepLinkMatchesRuntime(
          { scheme, pluginId: "installed", toolName: "app", url: "/" },
          runtime,
        ),
      ).toBe(allowed);
    },
  );
  it("picks schemes from the client runtime alone, never a platform", () => {
    // Extra arguments (a stale platform) cannot widen what a runtime accepts.
    const loose = pluginDeepLinkMatchesRuntime as (
      ...args: unknown[]
    ) => boolean;
    expect(loose({ scheme: "codex" }, "chatgpt", "desktop")).toBe(false);
    expect(loose({ scheme: "https" }, "codex", "desktop")).toBe(false);
    expect(loose({ scheme: "chatgpt" }, "codex", "web")).toBe(false);
  });
  it("derives plain-server plugin IDs and recognizes links that round-trip", () => {
    const id = emulatedServerPluginId("k57abc");
    expect(id).toBe("server-k57abc");
    expect(isPluginDeepLink(localPluginDeepLink(id, "cad.library", "chatgpt"))).toBe(true);
    expect(isPluginDeepLink("https://example.com/plugins/a/app/b")).toBe(false);
    expect(isPluginDeepLink(42)).toBe(false);
  });
  it("decodes one segment and the complete inner path/query exactly once", () => {
    expect(
      parsePluginDeepLink(
        "codex://plugins/a%40b@market%20one/app/tool%2Fname?path=%2Fparts%3Fq%3Da%252Fb%26q%3Dtwo%26label%3Dx%2By",
      ),
    ).toEqual({
      scheme: "codex",
      pluginId: "a@b",
      marketplace: "market one",
      toolName: "tool/name",
      url: "/parts?q=a%2Fb&q=two&label=x+y",
    });
    expect(
      parsePluginDeepLink("chatgpt://plugins/installed/app/tool").url,
    ).toBe("/");
    expect(
      parsePluginDeepLink("https://chatgpt.com/plugins/installed/app/tool")
        .scheme,
    ).toBe("https");
    expect(
      parsePluginDeepLink(
        localPluginDeepLink("a@b", "t/name", "codex", "/x?a=1&a=2"),
      ).url,
    ).toBe("/x?a=1&a=2");
  });
  it.each([
    "javascript:alert(1)",
    "file:///tmp/x",
    "https://chatgpt.com.evil/plugins/a/app/t",
    "https://u@chatgpt.com/plugins/a/app/t",
    "https://chatgpt.com:443/plugins/a/app/t",
    "https://chatgpt.com/plugins/a@m/app/t",
    "codex://plugins/a@m@other/app/t",
    "codex://plugins/a/app/../t",
    "codex://plugins/a/app/%2e%2e",
    "codex://plugins/a/app/t/other",
    "codex://plugins/a/app/t#x",
    "codex://plugins/a/app/t?path=%2Fx%23y",
    "codex://plugins/a/app/t?path=https%3A%2F%2Fevil",
    "codex://plugins/a/app/t?path=%2F%2Fevil",
    "codex://plugins/a/app/t?path=%2Fone&path=%2Ftwo",
    "codex://plugins/a/app/t?other=x",
    "codex://plugins/a/app/%ZZ",
    "codex://plugins/a/app/t?path=%00",
    "codex://plugins/a/app/t?path=%ZZ",
    "codex://plugins/a/app/t?path=%2F%5Cevil",
    " codex://plugins/a/app/t",
    "codex://plugins//app/t",
  ])("rejects %s without URL normalization", (url) =>
    expect(() => parsePluginDeepLink(url)).toThrow("PLUGIN_DEEP_LINK_INVALID"),
  );
  it("bounds the envelope, segments and decoded path", () => {
    for (const url of [
      "x".repeat(8193),
      localPluginDeepLink("a", "t", "codex").replace(
        "/a/",
        `/${"a".repeat(257)}/`,
      ),
      `codex://plugins/a/app/t?path=${encodeURIComponent(
        "/" + "x".repeat(4096),
      )}`,
    ])
      expect(() => parsePluginDeepLink(url)).toThrow();
  });
});
