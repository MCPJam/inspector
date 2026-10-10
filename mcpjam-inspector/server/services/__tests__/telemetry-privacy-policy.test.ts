import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveTelemetryPolicy,
  setTelemetryPolicyQueryForTests,
  TELEMETRY_POLICY_CACHE_TTL_MS,
} from "../telemetry-privacy-policy.js";

const CONTEXT = { projectIds: ["p1"], organizationIds: ["o1"] };
const CONSERVATIVE = {
  policy: { recording: "masked", identity: "id_only" },
  resolved: false,
};

describe("resolveTelemetryPolicy", () => {
  afterEach(() => {
    setTelemetryPolicyQueryForTests(null);
    vi.useRealTimers();
  });

  it("asks the backend as the bearer and returns its answer", async () => {
    const query = vi.fn(async () => ({ recording: "full", identity: "full" }));
    setTelemetryPolicyQueryForTests(query);
    expect(await resolveTelemetryPolicy("token-1", CONTEXT)).toEqual({
      policy: { recording: "full", identity: "full" },
      resolved: true,
    });
    expect(query).toHaveBeenCalledWith(
      expect.any(String),
      "token-1",
      CONTEXT,
      expect.any(AbortSignal),
    );
  });

  it("never asks without a bearer", async () => {
    const query = vi.fn();
    setTelemetryPolicyQueryForTests(query);
    expect(await resolveTelemetryPolicy(null, CONTEXT)).toEqual(CONSERVATIVE);
    expect(query).not.toHaveBeenCalled();
  });

  it("is conservative when the backend refuses or fails", async () => {
    setTelemetryPolicyQueryForTests(async () => {
      throw new Error("Authentication required");
    });
    expect(await resolveTelemetryPolicy("t", CONTEXT)).toEqual(CONSERVATIVE);
  });

  it("is conservative for a malformed answer, keeping no extra fields", async () => {
    setTelemetryPolicyQueryForTests(async () => ({ recording: "full" }));
    expect(await resolveTelemetryPolicy("t", CONTEXT)).toEqual(CONSERVATIVE);
    setTelemetryPolicyQueryForTests(async () => ({
      recording: "full",
      identity: "full",
      organizationName: "leak",
    }));
    expect((await resolveTelemetryPolicy("t", CONTEXT)).policy).toEqual({
      recording: "full",
      identity: "full",
    });
  });

  it("is conservative when the backend does not answer in time, and aborts the call", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    setTelemetryPolicyQueryForTests((_url, _token, _context, s) => {
      signal = s;
      return new Promise(() => {});
    });
    const pending = resolveTelemetryPolicy("t", CONTEXT, { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toEqual(CONSERVATIVE);
    expect(signal?.aborted).toBe(true);
  });

  it("keeps a resolved answer briefly, per bearer and context", async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => ({ recording: "full", identity: "full" }));
    setTelemetryPolicyQueryForTests(query);
    await resolveTelemetryPolicy("t", CONTEXT);
    await resolveTelemetryPolicy("t", {
      projectIds: ["p1"],
      organizationIds: ["o1"],
    });
    expect(query).toHaveBeenCalledTimes(1);

    // Another bearer, or another context, is asked on its own.
    await resolveTelemetryPolicy("other", CONTEXT);
    await resolveTelemetryPolicy("t", { projectIds: [], organizationIds: [] });
    expect(query).toHaveBeenCalledTimes(3);

    // Past the TTL the backend is asked again.
    await vi.advanceTimersByTimeAsync(TELEMETRY_POLICY_CACHE_TTL_MS + 1);
    await resolveTelemetryPolicy("t", CONTEXT);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("does not keep an answer that did not resolve", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue({ recording: "full", identity: "full" });
    setTelemetryPolicyQueryForTests(query);
    expect(await resolveTelemetryPolicy("t", CONTEXT)).toEqual(CONSERVATIVE);
    expect((await resolveTelemetryPolicy("t", CONTEXT)).resolved).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("asks once for concurrent identical lookups", async () => {
    let release: (value: unknown) => void = () => {};
    const query = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    setTelemetryPolicyQueryForTests(query);
    const both = Promise.all([
      resolveTelemetryPolicy("t", CONTEXT),
      resolveTelemetryPolicy("t", CONTEXT),
    ]);
    release({ recording: "masked", identity: "id_only" });
    const [first, second] = await both;
    expect(first).toEqual(second);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("asks Convex's HTTP query API as the bearer", async () => {
    const saved = process.env.VITE_CONVEX_URL;
    const savedHttp = process.env.CONVEX_HTTP_URL;
    delete process.env.CONVEX_HTTP_URL;
    process.env.VITE_CONVEX_URL = "https://example-123.convex.cloud";
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: "success",
        value: { recording: "masked", identity: "id_only" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await resolveTelemetryPolicy("bearer-1", CONTEXT)).toEqual({
        policy: { recording: "masked", identity: "id_only" },
        resolved: true,
      });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        URL,
        RequestInit,
      ];
      expect(String(url)).toBe("https://example-123.convex.cloud/api/query");
      expect(init.headers).toMatchObject({ Authorization: "Bearer bearer-1" });
      expect(JSON.parse(init.body as string)).toEqual({
        path: "telemetryPrivacy:getContext",
        args: CONTEXT,
        format: "json",
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
      if (saved === undefined) delete process.env.VITE_CONVEX_URL;
      else process.env.VITE_CONVEX_URL = saved;
      if (savedHttp !== undefined) process.env.CONVEX_HTTP_URL = savedHttp;
    }
  });

  it("is conservative with no Convex deployment configured", async () => {
    const saved = {
      http: process.env.CONVEX_HTTP_URL,
      vite: process.env.VITE_CONVEX_URL,
    };
    delete process.env.CONVEX_HTTP_URL;
    delete process.env.VITE_CONVEX_URL;
    try {
      expect(await resolveTelemetryPolicy("t", CONTEXT)).toEqual(CONSERVATIVE);
    } finally {
      if (saved.http !== undefined) process.env.CONVEX_HTTP_URL = saved.http;
      if (saved.vite !== undefined) process.env.VITE_CONVEX_URL = saved.vite;
    }
  });
});
