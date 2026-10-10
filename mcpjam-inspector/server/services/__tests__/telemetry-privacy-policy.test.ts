import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveTelemetryPolicy,
  setTelemetryPolicyQueryForTests,
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
    expect(query).toHaveBeenCalledWith(expect.any(String), "token-1", CONTEXT);
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

  it("is conservative when the backend does not answer in time", async () => {
    vi.useFakeTimers();
    setTelemetryPolicyQueryForTests(() => new Promise(() => {}));
    const pending = resolveTelemetryPolicy("t", CONTEXT, { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toEqual(CONSERVATIVE);
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
