import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let telemetry: typeof import("../src/telemetry.js");
const original = {
  DO_NOT_TRACK: process.env.DO_NOT_TRACK,
  MCPJAM_TELEMETRY_DISABLED: process.env.MCPJAM_TELEMETRY_DISABLED,
};
const network = vi.fn().mockResolvedValue(new Response("{}"));

beforeEach(async () => {
  vi.resetModules();
  delete process.env.DO_NOT_TRACK;
  delete process.env.MCPJAM_TELEMETRY_DISABLED;
  network.mockClear();
  vi.stubGlobal("fetch", network);
  telemetry = await import("../src/telemetry.js");
});

afterEach(async () => {
  process.env.DO_NOT_TRACK = "1";
  await telemetry.shutdownSdkTelemetry();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

describe("SDK analytics boundary", () => {
  it("reconstructs actual posthog-node output and exposes no raw client", async () => {
    expect(telemetry).not.toHaveProperty("posthog");
    telemetry.captureSdkRun(12, 3);
    await telemetry.flushSdkTelemetry();
    expect(network).toHaveBeenCalledTimes(1);
    const [url, options] = network.mock.calls[0];
    expect(url).toBe("https://us.i.posthog.com/batch/");
    const { batch, ...envelope } = JSON.parse(options.body);
    expect(Object.keys(envelope)).toEqual(["api_key"]);
    expect(batch).toHaveLength(1);
    expect(batch[0]).toEqual({
      event: "eval_test_run_triggered",
      distinct_id: "anonymous",
      timestamp: expect.any(String),
      properties: {
        iterations: 12,
        concurrency: 3,
        $geoip_disable: true,
        $process_person_profile: false,
        $insert_id: expect.stringMatching(/^[a-f0-9-]{36}$/),
      },
    });
  });

  it.each(["DO_NOT_TRACK", "MCPJAM_TELEMETRY_DISABLED"])(
    "honors %s at import, capture and queued delivery",
    async (key) => {
      await telemetry.shutdownSdkTelemetry();
      process.env[key] = "true";
      vi.resetModules();
      telemetry = await import("../src/telemetry.js");
      telemetry.captureSdkRun(1, 1);
      await telemetry.flushSdkTelemetry();
      expect(network).not.toHaveBeenCalled();
      delete process.env[key];
      telemetry.captureSdkRun(2, 1);
      process.env[key] = "1";
      await telemetry.flushSdkTelemetry();
      expect(network).not.toHaveBeenCalled();
      delete process.env[key];
      telemetry.captureSdkRun(3, 1);
      await telemetry.flushSdkTelemetry();
      expect(network).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(network.mock.calls[0][1].body).batch[0].properties.iterations
      ).toBe(3);
    }
  );

  it("rejects invalid run counts before creating a sender", async () => {
    for (const invalid of [0, -1, 1.1, Infinity, NaN, "2", {}, 1000001])
      telemetry.captureSdkRun(invalid, 1);
    for (const invalid of [0, -1, 1.1, Infinity, NaN, "2", {}, 1025])
      telemetry.captureSdkRun(1, invalid);
    await telemetry.flushSdkTelemetry();
    expect(network).not.toHaveBeenCalled();
  });

  it("rebuilds hostile queued envelopes and rechecks DNT on retry", async () => {
    const record = {
      event: "eval_test_run_triggered",
      distinct_id: "PRIVATE_SENTINEL",
      properties: {
        iterations: 1,
        concurrency: 2,
        $set: { email: "PRIVATE_SENTINEL" },
        $current_url: "PRIVATE_SENTINEL",
      },
      timestamp: "PRIVATE_SENTINEL",
      context: "PRIVATE_SENTINEL",
    };
    const options = {
      method: "POST" as const,
      headers: {},
      body: JSON.stringify({
        api_key: "PRIVATE_SENTINEL",
        extra: "PRIVATE_SENTINEL",
        batch: [
          record,
          { ...record, event: "$identify" },
          { ...record, properties: { iterations: -1, concurrency: 2 } },
        ],
      }),
    };
    await telemetry.sdkAnalyticsTransport(
      "https://us.i.posthog.com/batch/",
      options
    );
    expect(network).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(network.mock.calls[0][1].body);
    expect(payload.batch).toHaveLength(1);
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_SENTINEL");
    process.env.DO_NOT_TRACK = "true";
    await telemetry.sdkAnalyticsTransport(
      "https://us.i.posthog.com/batch/",
      options
    );
    delete process.env.DO_NOT_TRACK;
    await telemetry.sdkAnalyticsTransport(
      "https://us.i.posthog.com/flags/?v=2",
      options
    );
    await telemetry.sdkAnalyticsTransport("https://us.i.posthog.com/batch/", {
      ...options,
      body: "invalid",
    });
    expect(network).toHaveBeenCalledTimes(1);
  });
});
