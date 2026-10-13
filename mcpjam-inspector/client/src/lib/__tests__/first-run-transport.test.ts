import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@/lib/config");
  vi.resetModules();
});

it.each([
  ["mcp.example.com/mcp", "http"],
  ["localhost:3000/mcp", "http"],
  ["ftp://host", "http"],
  ["HTTPS://mcp.example.com/mcp", "http"],
  ["npx -y server-example", "stdio"],
  ["./server.js", "stdio"],
  ["/usr/local/bin/server", "stdio"],
  ["server-example", "stdio"],
])("infers hosted input %s as %s", async (input, expected) => {
  vi.resetModules();
  vi.doMock("@/lib/config", () => ({ HOSTED_MODE: true }));
  const { inferFirstRunTransport } = await import("../server-form-validation");
  expect(inferFirstRunTransport(input)).toBe(expected);
});

it("preserves explicit transports and command inference in local mode", async () => {
  vi.resetModules();
  vi.doMock("@/lib/config", () => ({ HOSTED_MODE: false }));
  const { inferFirstRunTransport } = await import("../server-form-validation");
  expect(inferFirstRunTransport("server.example")).toBe("stdio");
  expect(inferFirstRunTransport("https://example.com", "stdio")).toBe("stdio");
  expect(inferFirstRunTransport("server.example", "http")).toBe("http");
});
