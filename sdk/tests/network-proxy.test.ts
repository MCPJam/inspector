import { describe, expect, it } from "vitest";
import {
  proxySettings,
  redactProxyUrl,
} from "../src/internal/network-proxy.js";

describe("proxy settings from the environment", () => {
  it("does not let an empty lowercase variable switch the proxy off", () => {
    // undici reads `https_proxy` first with `??`, so `https_proxy=""` beside
    // a real HTTPS_PROXY meant no proxy at all; this resolves it explicitly.
    expect(
      proxySettings({
        https_proxy: "",
        HTTPS_PROXY: "http://proxy.corp:3128",
        no_proxy: "",
        NO_PROXY: "localhost",
      })
    ).toEqual({
      httpsProxy: "http://proxy.corp:3128",
      httpProxy: null,
      noProxy: "localhost",
    });
    expect(
      proxySettings({ https_proxy: "http://lower:1", HTTPS_PROXY: "http://upper:2" })
        .httpsProxy
    ).toBe("http://lower:1");
  });

  it("prints a proxy URL without its credentials", () => {
    expect(redactProxyUrl("http://alice:s3cret@proxy.corp:3128")).toBe(
      "http://***@proxy.corp:3128"
    );
    expect(redactProxyUrl(null)).toBe(null);
  });
});
