import { describe, expect, it } from "vitest";
import {
  checkHostedServerInput,
  inferFirstRunTransport,
  LOCAL_INSPECTOR_COMMAND,
  withDefaultUrlScheme,
} from "../hosted-connect-precheck";

describe("checkHostedServerInput", () => {
  it("blocks a stdio command and offers it back to copy", () => {
    expect(checkHostedServerInput("npx -y @acme/mcp", "stdio")).toEqual({
      kind: "blocked",
      reason: "stdio",
      copyCommand: "npx -y @acme/mcp",
    });
  });

  it.each([
    "http://localhost:3000/mcp",
    "localhost:3000/mcp",
    "http://127.0.0.1:8080",
    "http://[::1]:3000/mcp",
    "http://app.localhost/mcp",
    "http://localhost./mcp",
    "https://[::ffff:7f00:1]:3000/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
  ])("blocks loopback %s", (input) => {
    expect(checkHostedServerInput(input, "http")).toEqual({
      kind: "blocked",
      reason: "localhost",
      copyCommand: LOCAL_INSPECTOR_COMMAND,
    });
  });

  it.each(["http://192.168.1.20/mcp", "https://10.0.0.5/mcp"])(
    "only warns about private %s",
    (input) => {
      expect(checkHostedServerInput(input, "http")).toEqual({
        kind: "private_network",
      });
    },
  );

  it.each(["https://mcp.example.com/mcp", "http://mcp.example.com/mcp", ""])(
    "leaves %s to the form validator",
    (input) => {
      expect(checkHostedServerInput(input, "http")).toEqual({ kind: "ok" });
    },
  );
});

describe("inferFirstRunTransport", () => {
  it.each([
    ["https://mcp.example.com/mcp", true, "http"],
    ["mcp.example.com/mcp", true, "http"],
    ["localhost:3000/mcp", true, "http"],
    ["npx -y @acme/mcp", true, "stdio"],
    ["server.py", true, "stdio"],
    ["./server", true, "stdio"],
    ["mcp.example.com/mcp", false, "stdio"],
    ["http://localhost:3000", false, "http"],
  ] as const)("%s (hosted %s) is %s", (input, hosted, expected) => {
    expect(inferFirstRunTransport(input, hosted)).toBe(expected);
  });
});

describe("withDefaultUrlScheme", () => {
  it.each([
    ["mcp.example.com/mcp", "https://mcp.example.com/mcp"],
    ["https://mcp.example.com/mcp", "https://mcp.example.com/mcp"],
    ["http://mcp.example.com/mcp", "http://mcp.example.com/mcp"],
  ])("%s becomes %s", (input, expected) => {
    expect(withDefaultUrlScheme(input)).toBe(expected);
  });
});
