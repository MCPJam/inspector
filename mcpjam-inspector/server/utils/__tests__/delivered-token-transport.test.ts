import { describe, expect, it, vi } from "vitest";
import { bindDeliveredToken } from "../delivered-oauth-credential.js";

describe("delivered token transport", () => {
  it.each(["http://192.0.2.1/mcp", "http://internal.example/mcp"])(
    "refuses %s before sending",
    (url) => {
      const fetchFn = vi.fn();
      expect(() =>
        bindDeliveredToken({
          fetchFn,
          url,
          token: "secret",
          accountKind: "shared",
          boundOrigins: [url],
          target: {},
        }),
      ).toThrow("needs HTTPS");
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );
  it.each([
    "http://127.0.0.1/mcp",
    "http://localhost/mcp",
    "http://[::1]/mcp",
    "https://10.0.0.1/mcp",
  ])("allows %s", (url) => {
    expect(() =>
      bindDeliveredToken({
        fetchFn: vi.fn(),
        url,
        token: "secret",
        accountKind: "shared",
        boundOrigins: [url],
        target: {},
      }),
    ).not.toThrow();
  });
  it("strips credentials on a redirect to an insecure bound origin", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "http://internal.example/mcp" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok"));
    const bound = bindDeliveredToken({
      fetchFn,
      url: "https://internal.example/mcp",
      token: "secret",
      accountKind: "shared",
      boundOrigins: ["https://internal.example", "http://internal.example"],
      target: {},
    });
    await bound("https://internal.example/mcp", {
      headers: { authorization: "Bearer secret" },
    });
    expect(
      new Headers(fetchFn.mock.calls[1][1].headers).has("authorization"),
    ).toBe(false);
  });
});

it("preserves personal OAuth over remote HTTP", async () => {
  const fetchFn = vi.fn().mockResolvedValue(new Response("ok"));
  const fetchPersonal = bindDeliveredToken({
    fetchFn,
    url: "http://personal.example/mcp",
    token: "personal",
    boundOrigins: ["http://personal.example"],
    target: {},
  });
  await fetchPersonal("http://personal.example/mcp", {
    headers: { authorization: "Bearer personal" },
  });
  expect(
    new Headers(fetchFn.mock.calls[0][1].headers).get("authorization"),
  ).toBe("Bearer personal");
});
