/**
 * Tests for the SDK→backend eval capability probe (Stage 5, Step 3).
 *
 * Behavior under test:
 *  1. Parses the nested `{ capabilities: { evalsHostConfig: N } }` shape.
 *  2. Tolerates a future flat `{ evalsHostConfig: N }` shape.
 *  3. Returns `{ evalsHostConfig: 0 }` on 404 (older backends).
 *  4. Returns `{ evalsHostConfig: 0 }` on network error / abort timeout.
 *  5. Returns `{ evalsHostConfig: 0 }` when the field is missing or
 *     non-numeric.
 *  6. Caches per baseUrl — repeat calls share one fetch.
 *  7. Distinct baseUrls are independent.
 */

import { vi } from "vitest";
import {
  __resetSdkEvalsCapabilitiesCache,
  resolveSdkEvalsCapabilities,
} from "../src/sdk-evals-capability";

function jsonResponse(body: unknown, status = 200): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  };
}

beforeEach(() => {
  __resetSdkEvalsCapabilitiesCache();
});

afterEach(() => {
  __resetSdkEvalsCapabilitiesCache();
});

describe("resolveSdkEvalsCapabilities", () => {
  it("parses nested { capabilities: { evalsHostConfig } } shape", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ capabilities: { evalsHostConfig: 1 } })
      );
    const result = await resolveSdkEvalsCapabilities(
      "https://api.example.com",
      fetchMock as unknown as typeof fetch
    );
    expect(result.evalsHostConfig).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.example.com/sdk/v1/info"
    );
  });

  it("tolerates flat { evalsHostConfig } body shape", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ evalsHostConfig: 2 }));
    const result = await resolveSdkEvalsCapabilities(
      "https://api.example.com",
      fetchMock as unknown as typeof fetch
    );
    expect(result.evalsHostConfig).toBe(2);
  });

  it("returns 0 when /sdk/v1/info returns 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 404));
    const result = await resolveSdkEvalsCapabilities(
      "https://api.example.com",
      fetchMock as unknown as typeof fetch
    );
    expect(result.evalsHostConfig).toBe(0);
  });

  it("returns 0 on network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const result = await resolveSdkEvalsCapabilities(
      "https://api.example.com",
      fetchMock as unknown as typeof fetch
    );
    expect(result.evalsHostConfig).toBe(0);
  });

  it("returns 0 on AbortError (timeout)", async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    const result = await resolveSdkEvalsCapabilities(
      "https://api.example.com",
      fetchMock as unknown as typeof fetch
    );
    expect(result.evalsHostConfig).toBe(0);
  });

  it("returns 0 on body parse failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw new SyntaxError("not JSON");
      },
    });
    const result = await resolveSdkEvalsCapabilities(
      "https://api.example.com",
      fetchMock as unknown as typeof fetch
    );
    expect(result.evalsHostConfig).toBe(0);
  });

  it("returns 0 when capabilities is missing or non-numeric", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(
        jsonResponse({ capabilities: { evalsHostConfig: "1" } })
      )
      .mockResolvedValueOnce(
        jsonResponse({ capabilities: { evalsHostConfig: null } })
      );

    const a = await resolveSdkEvalsCapabilities(
      "https://a.example.com",
      fetchMock as unknown as typeof fetch
    );
    const b = await resolveSdkEvalsCapabilities(
      "https://b.example.com",
      fetchMock as unknown as typeof fetch
    );
    const c = await resolveSdkEvalsCapabilities(
      "https://c.example.com",
      fetchMock as unknown as typeof fetch
    );
    expect(a.evalsHostConfig).toBe(0);
    expect(b.evalsHostConfig).toBe(0);
    expect(c.evalsHostConfig).toBe(0);
  });

  it("caches per baseUrl — repeated calls share one fetch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ capabilities: { evalsHostConfig: 1 } })
      );
    const a = await resolveSdkEvalsCapabilities(
      "https://api.example.com",
      fetchMock as unknown as typeof fetch
    );
    const b = await resolveSdkEvalsCapabilities(
      "https://api.example.com",
      fetchMock as unknown as typeof fetch
    );
    const c = await resolveSdkEvalsCapabilities(
      "https://api.example.com/",
      fetchMock as unknown as typeof fetch
    );
    expect(a.evalsHostConfig).toBe(1);
    expect(b.evalsHostConfig).toBe(1);
    expect(c.evalsHostConfig).toBe(1);
    // Trailing slash normalized to same cache key as the bare URL.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("distinct baseUrls produce independent probes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ capabilities: { evalsHostConfig: 1 } })
      )
      .mockResolvedValueOnce(jsonResponse({}, 404));
    const a = await resolveSdkEvalsCapabilities(
      "https://a.example.com",
      fetchMock as unknown as typeof fetch
    );
    const b = await resolveSdkEvalsCapabilities(
      "https://b.example.com",
      fetchMock as unknown as typeof fetch
    );
    expect(a.evalsHostConfig).toBe(1);
    expect(b.evalsHostConfig).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("concurrent first-callers share one in-flight fetch", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );
    const p1 = resolveSdkEvalsCapabilities(
      "https://api.example.com",
      fetchMock as unknown as typeof fetch
    );
    const p2 = resolveSdkEvalsCapabilities(
      "https://api.example.com",
      fetchMock as unknown as typeof fetch
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(jsonResponse({ capabilities: { evalsHostConfig: 1 } }));
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.evalsHostConfig).toBe(1);
    expect(b.evalsHostConfig).toBe(1);
  });
});
