import { describe, expect, it } from "vitest";
import { HttpsProxyAgent } from "https-proxy-agent";
import { relayProxyAgent } from "../relay-proxy-agent.js";

const RELAY = "wss://agent.tunnels.mcpjam.com/agent";
const PROXY = "http://proxy.corp:3128";

/** The proxy the agent tunnels through, or null for a direct dial. */
function proxyFor(url: string, env: NodeJS.ProcessEnv): string | null {
  const agent = relayProxyAgent(url, env);
  if (agent === undefined) return null;
  if (!(agent instanceof HttpsProxyAgent)) {
    throw new Error("Expected a CONNECT proxy agent");
  }
  return agent.proxy.href;
}

describe("relayProxyAgent", () => {
  it("dials directly when no proxy is set", () => {
    expect(proxyFor(RELAY, {})).toBeNull();
    expect(proxyFor(RELAY, { NO_PROXY: "corp.test" })).toBeNull();
  });

  it("tunnels a wss relay through HTTPS_PROXY in either case", () => {
    expect(proxyFor(RELAY, { HTTPS_PROXY: PROXY })).toBe(`${PROXY}/`);
    expect(proxyFor(RELAY, { https_proxy: PROXY })).toBe(`${PROXY}/`);
    // An empty lowercase value does not hide the uppercase one.
    expect(proxyFor(RELAY, { https_proxy: "", HTTPS_PROXY: PROXY })).toBe(
      `${PROXY}/`,
    );
  });

  it("falls back to HTTP_PROXY for wss, and uses only HTTP_PROXY for ws", () => {
    expect(proxyFor(RELAY, { HTTP_PROXY: PROXY })).toBe(`${PROXY}/`);
    expect(
      proxyFor("ws://edge.corp.test:8787/agent", { HTTPS_PROXY: PROXY }),
    ).toBeNull();
    expect(
      proxyFor("ws://edge.corp.test:8787/agent", { HTTP_PROXY: PROXY }),
    ).toBe(`${PROXY}/`);
  });

  it("reads a proxy without a scheme as http", () => {
    expect(proxyFor(RELAY, { HTTPS_PROXY: "proxy.corp:3128" })).toBe(
      `${PROXY}/`,
    );
  });

  it("dials directly for a relay host NO_PROXY matches", () => {
    const env = (noProxy: string) => ({
      HTTPS_PROXY: PROXY,
      no_proxy: noProxy,
    });
    expect(proxyFor(RELAY, env("agent.tunnels.mcpjam.com"))).toBeNull();
    expect(proxyFor(RELAY, env("mcpjam.com"))).toBeNull();
    expect(proxyFor(RELAY, env(".mcpjam.com"))).toBeNull();
    expect(proxyFor(RELAY, env("*.mcpjam.com"))).toBeNull();
    expect(proxyFor(RELAY, env("corp.test, MCPJAM.com"))).toBeNull();
    expect(proxyFor(RELAY, env("mcpjam.com:443"))).toBeNull();
    expect(proxyFor(RELAY, env("*"))).toBeNull();
    expect(proxyFor(RELAY, env("corp.test,*"))).toBeNull();
  });

  it("still proxies a relay host NO_PROXY does not match", () => {
    const env = (noProxy: string) => ({
      HTTPS_PROXY: PROXY,
      NO_PROXY: noProxy,
    });
    expect(proxyFor(RELAY, env("corp.test"))).toBe(`${PROXY}/`);
    expect(proxyFor(RELAY, env("tunnels.mcpjam.com.evil"))).toBe(`${PROXY}/`);
    expect(proxyFor(RELAY, env("jam.com"))).toBe(`${PROXY}/`);
    expect(proxyFor(RELAY, env("mcpjam.com:8443"))).toBe(`${PROXY}/`);
  });

  it("dials loopback directly, so a local tunnel edge keeps working", () => {
    const env = { HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY };
    expect(proxyFor("ws://localhost:8787/agent", env)).toBeNull();
    expect(proxyFor("ws://127.0.0.1:8787/agent", env)).toBeNull();
    expect(proxyFor("wss://[::1]:8787/agent", env)).toBeNull();
    // All of 127.0.0.0/8, in any spelling URL normalizes.
    expect(proxyFor("ws://127.0.0.2:8787/agent", env)).toBeNull();
    expect(proxyFor("ws://127.1:8787/agent", env)).toBeNull();
    expect(proxyFor("ws://128.0.0.1:8787/agent", env)).toBe(`${PROXY}/`);
  });

  it("ignores a proxy that is not an http(s) URL rather than misusing it", () => {
    expect(proxyFor(RELAY, { HTTPS_PROXY: "socks5://proxy.corp:1080" })).toBe(
      null,
    );
  });

  it("leaves an unparseable relay URL for ws to reject", () => {
    expect(proxyFor("not a url", { HTTPS_PROXY: PROXY })).toBeNull();
  });
});
