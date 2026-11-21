import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { createConvexClients } from "../evals";

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
  vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a run's Convex client", () => {
  it("authenticates with each renewal of a renewing bearer", () => {
    const setAuth = vi.spyOn(ConvexHttpClient.prototype, "setAuth");
    let renew: (token: string) => void = () => {};
    createConvexClients({
      current: () => "job-token-1",
      onRenew: (listener) => {
        renew = listener;
      },
    });
    expect(setAuth).toHaveBeenLastCalledWith("job-token-1");
    renew("job-token-2");
    expect(setAuth).toHaveBeenLastCalledWith("job-token-2");
  });

  it("keeps a plain token for good", () => {
    const setAuth = vi.spyOn(ConvexHttpClient.prototype, "setAuth");
    createConvexClients("plain-token");
    expect(setAuth).toHaveBeenCalledExactlyOnceWith("plain-token");
  });
});
