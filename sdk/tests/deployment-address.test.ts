import { describe, expect, it, vi } from "vitest";
import {
  backendFetch,
  deploymentFromEnv,
  isMcpjamDeploymentError,
  McpjamDeploymentError,
  parseApiUrl,
  parseBaseUrl,
  sameServer,
} from "../src/deployment/address.js";

describe("server addresses", () => {
  it("normalizes scheme, host case, default port and trailing slashes", () => {
    expect(
      parseApiUrl("HTTPS://A.Example.TEST:443/api/v1///", "--api-url")
    ).toEqual({
      apiUrl: "https://a.example.test/api/v1",
      baseUrl: "https://a.example.test",
    });
    expect(parseBaseUrl("http://127.0.0.1:80/", "MCPJAM_BASE_URL")).toEqual({
      apiUrl: "http://127.0.0.1/api/v1",
      baseUrl: "http://127.0.0.1",
    });
  });

  it("strips /api/v1 exactly once, so a path prefix stays", () => {
    expect(
      parseApiUrl("https://x.test/prefix/api/v1", "--api-url").baseUrl
    ).toBe("https://x.test/prefix");
    expect(parseApiUrl("https://x.test", "--api-url")).toEqual({
      apiUrl: "https://x.test",
      baseUrl: "https://x.test",
    });
  });

  it("compares servers whether or not /api/v1 is spelled", () => {
    expect(
      sameServer(
        parseApiUrl("https://a.test/api/v1", "--api-url"),
        parseBaseUrl("https://A.test/", "MCPJAM_BASE_URL")
      )
    ).toBe(true);
    expect(
      sameServer(
        parseApiUrl("https://a.test/api/v1", "--api-url"),
        parseApiUrl("https://a.test:8443/api/v1", "--api-url")
      )
    ).toBe(false);
  });

  it.each([
    [
      "not a url",
      /Expected a full URL like https:\/\/app\.mcpjam\.com\/api\/v1\./,
    ],
    ["ftp://a.test/api/v1", /Expected an http\(s\) URL/],
    ["https://user:secret@a.test/api/v1", /no credentials, query or fragment/],
    ["https://a.test/api/v1?tenant=1", /no credentials, query or fragment/],
  ])("refuses %s", (value, message) => {
    let thrown: unknown;
    try {
      parseApiUrl(value, "--api-url");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpjamDeploymentError);
    expect(thrown).toMatchObject({ code: "API_URL_INVALID" });
    expect((thrown as Error).message).toMatch(message);
  });

  it("never repeats credentials, a query, a fragment or a non-URL in a refusal", () => {
    const refusal = (value: string) => {
      try {
        parseApiUrl(value, "MCPJAM_API_URL");
      } catch (error) {
        if (error instanceof McpjamDeploymentError) return error;
      }
      throw new Error(`expected ${value} to be refused`);
    };
    const withSecrets = refusal(
      "https://user:s3cret@a.test/api/v1?token=t0k#frag"
    );
    expect(withSecrets.message).toBe(
      'Invalid MCPJAM_API_URL value "https://***@a.test/api/v1?***#***". Expected a server address with no credentials, query or fragment, like https://app.mcpjam.com/api/v1.'
    );
    expect(withSecrets.apiUrl).toBe("https://***@a.test/api/v1?***#***");
    const apiKey = refusal("sk_live_0123456789");
    expect(apiKey.message).toBe(
      "Invalid MCPJAM_API_URL value. Expected a full URL like https://app.mcpjam.com/api/v1."
    );
    expect(apiKey.apiUrl).toBe("");
  });

  it("reads nothing when neither variable is set", () => {
    expect(
      deploymentFromEnv({ MCPJAM_API_URL: " ", MCPJAM_BASE_URL: "" })
    ).toBe(undefined);
  });

  it("recognizes a refusal thrown by another bundle's copy of the class", () => {
    const foreign = Object.assign(new Error("refused"), {
      [Symbol.for("mcpjam.deploymentError")]: true,
      code: "DEPLOYMENT_CONFLICT",
    });
    expect(isMcpjamDeploymentError(foreign)).toBe(true);
    expect(isMcpjamDeploymentError(new Error("other"))).toBe(false);
  });
});

describe("backendFetch", () => {
  it("passes an answer through and never lets fetch follow a redirect", async () => {
    const send = vi.fn(async () => Response.json({ ok: true }));
    const response = await backendFetch(send)("https://a.test/api/v1/me", {
      headers: { "x-edge": "secret" },
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith("https://a.test/api/v1/me", {
      headers: { "x-edge": "secret" },
      redirect: "manual",
    });
  });

  it.each([301, 302, 303, 307, 308])("refuses a %s", async (status) => {
    const send = vi.fn(
      async () =>
        new Response("moved", {
          status,
          headers: {
            location: "https://login.example.test/sso?state=one-time-secret",
          },
        })
    );
    const request = backendFetch(send)("https://a.test/api/v1/me?x=1");
    await expect(request).rejects.toMatchObject({
      code: "BACKEND_REDIRECT_REFUSED",
    });
    const error = await request.catch((caught: Error) => caught);
    expect(error.message).toBe(
      "MCPJam at https://a.test answered /api/v1/me with a redirect to https://login.example.test, which MCPJam requests never follow. Check that the server address points at the MCPJam API."
    );
    expect(error.message).not.toContain("one-time-secret");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses an opaque browser redirect, which names no target", async () => {
    const opaque = {
      type: "opaqueredirect",
      status: 0,
      headers: new Headers(),
      body: null,
    } as Response;
    await expect(
      backendFetch(async () => opaque)(new URL("https://a.test/api/v1/me"))
    ).rejects.toThrow(
      "MCPJam at https://a.test answered /api/v1/me with a redirect, which"
    );
  });
});
