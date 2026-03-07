import { describe, expect, it, vi } from "vitest";
import { executeOAuthProxy, OAuthProxyError } from "../oauth-proxy.js";

// Mock fetch globally so valid URLs don't make real requests
const fetchMock = vi.fn().mockResolvedValue({
  status: 200,
  statusText: "OK",
  headers: new Headers(),
  json: async () => ({ ok: true }),
  text: async () => "",
});
vi.stubGlobal("fetch", fetchMock);

describe("validateUrl — private IP blocking (httpsOnly)", () => {
  const privateHosts = [
    "https://127.0.0.1/foo",
    "https://10.0.0.1/foo",
    "https://172.16.0.1/foo",
    "https://192.168.1.1/foo",
    "https://169.254.169.254/foo",
    "https://[::1]/foo",
    "https://0.0.0.0/foo",
    "https://localhost/foo",
  ];

  for (const url of privateHosts) {
    it(`blocks ${url} when httpsOnly`, async () => {
      await expect(executeOAuthProxy({ url, httpsOnly: true })).rejects.toThrow(
        OAuthProxyError,
      );

      await expect(
        executeOAuthProxy({ url, httpsOnly: true }),
      ).rejects.toMatchObject({ status: 400 });
    });
  }

  it("allows https://example.com/foo when httpsOnly", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({ ok: true }),
      text: async () => "",
    });

    const result = await executeOAuthProxy({
      url: "https://example.com/foo",
      httpsOnly: true,
    });
    expect(result.status).toBe(200);
  });

  it("allows http://127.0.0.1 when httpsOnly is false (no IP blocking)", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({ ok: true }),
      text: async () => "",
    });

    const result = await executeOAuthProxy({
      url: "http://127.0.0.1",
      httpsOnly: false,
    });
    expect(result.status).toBe(200);
  });
});
