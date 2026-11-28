import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isMockAddress, pointAtMockRoute } from "../mock-servers.js";

beforeEach(() => {
  process.env.MCPJAM_INSPECTOR_PUBLIC_URL = "http://127.0.0.1:6274";
});
afterEach(() => {
  delete process.env.MCPJAM_INSPECTOR_PUBLIC_URL;
});

describe("pointAtMockRoute", () => {
  const mock = { url: "https://mock.mcpjam.invalid/mock%201", requestInit: { headers: { "x-keep": "1" } } };

  it("swaps a mock's placeholder for the route's address and presents the caller's bearer", () => {
    const config = pointAtMockRoute(mock, "sk_ann");
    expect(config.url).toBe("http://127.0.0.1:6274/api/web/mock-mcp/mock%201");
    expect(config.requestInit?.headers).toEqual({ "x-keep": "1", authorization: "Bearer sk_ann" });
    expect(config).toMatchObject({ preferSSE: false, disableSseFallback: true });
  });

  it("uses the configured public address when there is one", () => {
    process.env.MCPJAM_INSPECTOR_PUBLIC_URL = "https://inspector.example/";
    expect(pointAtMockRoute(mock, "t").url).toBe("https://inspector.example/api/web/mock-mcp/mock%201");
  });

  it("leaves any other server as it is", () => {
    const other = { url: "https://real.example/mcp" };
    expect(pointAtMockRoute(other, "t")).toBe(other);
    const stdio = { command: "node", args: [] };
    expect(pointAtMockRoute(stdio, "t")).toBe(stdio);
  });

  it("recognizes a mock's address", () => {
    expect(isMockAddress(mock.url)).toBe(true);
    expect(isMockAddress("https://real.example/mcp")).toBe(false);
    expect(isMockAddress(undefined)).toBe(false);
  });
});
