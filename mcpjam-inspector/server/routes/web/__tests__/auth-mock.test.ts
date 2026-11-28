import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toHttpConfig } from "../auth.js";

const authorized = (url: string) =>
  ({
    serverConfig: { transportType: "http", url, headers: { "x-saved": "1" } },
  }) as Parameters<typeof toHttpConfig>[0];

beforeEach(() => {
  process.env.MCPJAM_INSPECTOR_PUBLIC_URL = "https://inspector.example";
});
afterEach(() => {
  delete process.env.MCPJAM_INSPECTOR_PUBLIC_URL;
});

describe("toHttpConfig for a saved mock", () => {
  it("answers with the mock route's address and the caller's own bearer", () => {
    const config = toHttpConfig(
      authorized("https://mock.mcpjam.invalid/mock1"),
      5_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { caller: {}, bearerToken: "sk_ann", projectId: "p", reauthorize: async () => ({}) },
    );
    expect(config.url).toBe("https://inspector.example/api/web/mock-mcp/mock1");
    expect(config.requestInit?.headers).toMatchObject({ authorization: "Bearer sk_ann", "x-saved": "1" });
  });

  it("leaves an ordinary saved server's address alone", () => {
    const config = toHttpConfig(authorized("https://real.example/mcp"), 5_000, "tok", undefined, undefined, undefined, undefined, { caller: {}, bearerToken: "sk_ann", projectId: "p", reauthorize: async () => ({}) });
    expect(config.url).toBe("https://real.example/mcp");
    expect(config.requestInit?.headers).toMatchObject({ Authorization: "Bearer tok" });
  });
});
