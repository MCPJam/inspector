import { describe, expect, it } from "vitest";
import {
  isLocalOnlyMcpServerConfig,
  isUnsafeHostedOutboundUrl,
} from "../local-only-mcp";

describe("isLocalOnlyMcpServerConfig", () => {
  it("treats stdio configs as local-only", () => {
    expect(isLocalOnlyMcpServerConfig({ command: "npx" })).toBe(true);
  });

  it.each([
    "http://localhost:6277/mcp",
    "http://foo.localhost/mcp",
    "http://127.0.0.1:6277/mcp",
    "http://0.0.0.0:6277/mcp",
    "http://10.0.0.5/mcp",
    "http://172.16.0.5/mcp",
    "http://172.31.255.255/mcp",
    "http://192.168.1.5/mcp",
    "http://169.254.169.254/mcp",
    "http://[::1]/mcp",
    "http://[fe80::1]/mcp",
    "http://[fc00::1]/mcp",
    "http://[fd12:3456::1]/mcp",
  ])("treats private HTTP targets as local-only: %s", (url) => {
    expect(isLocalOnlyMcpServerConfig({ url })).toBe(true);
  });

  it.each([
    "https://mcp.example.com/mcp",
    "https://api.githubcopilot.com/mcp",
    "https://8.8.8.8/mcp",
    "https://[2001:db8::1]/mcp",
  ])("keeps public HTTP targets cloud-reachable: %s", (url) => {
    expect(isLocalOnlyMcpServerConfig({ url })).toBe(false);
  });

  it("does not force unknown configs to local runtime", () => {
    expect(isLocalOnlyMcpServerConfig(undefined)).toBe(false);
    expect(isLocalOnlyMcpServerConfig({})).toBe(false);
  });
});

describe("isUnsafeHostedOutboundUrl", () => {
  it("fails closed for malformed or non-http URLs", () => {
    expect(isUnsafeHostedOutboundUrl("not a url")).toBe(true);
    expect(isUnsafeHostedOutboundUrl("file:///tmp/server.sock")).toBe(true);
  });
});
