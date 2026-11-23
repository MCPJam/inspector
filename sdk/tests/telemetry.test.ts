import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let telemetry: typeof import("../src/telemetry.js");
const original = {
  DO_NOT_TRACK: process.env.DO_NOT_TRACK,
  MCPJAM_TELEMETRY_DISABLED: process.env.MCPJAM_TELEMETRY_DISABLED,
};
const network = vi.fn().mockResolvedValue(new Response("{}"));
const RUN = { suite: "protocol", mode: "single" } as const;
const SEMVER = /^\d+\.\d+\.\d+/;
const sentBatch = (call = 0) =>
  JSON.parse(network.mock.calls[call][1].body).batch;

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
        sdk_version: expect.stringMatching(SEMVER),
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

describe("conformance run ping", () => {
  it("sends one rebuilt, anonymous event in a single bounded attempt", async () => {
    await telemetry.captureConformanceRun("sdk", RUN);
    expect(network).toHaveBeenCalledTimes(1);
    const [url, options] = network.mock.calls[0];
    expect(url).toBe("https://us.i.posthog.com/batch/");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const { batch, ...envelope } = JSON.parse(options.body);
    expect(Object.keys(envelope)).toEqual(["api_key"]);
    expect(batch).toEqual([
      {
        event: "conformance_run_triggered",
        distinct_id: "anonymous",
        timestamp: expect.any(String),
        properties: {
          run_source: "sdk",
          suite: "protocol",
          mode: "single",
          sdk_version: expect.stringMatching(SEMVER),
          $geoip_disable: true,
          $process_person_profile: false,
          $insert_id: expect.stringMatching(/^[a-f0-9-]{36}$/),
        },
      },
    ]);
  });

  it.each(["api", "github_app", "benchmark"] as const)(
    "labels a hosted %s run",
    async (runSource) => {
      await telemetry.captureConformanceRun(runSource, RUN);
      const { batch } = JSON.parse(network.mock.calls[0][1].body);
      expect(batch[0].properties.run_source).toBe(runSource);
    }
  );

  it.each([
    ["DO_NOT_TRACK", "1"],
    ["DO_NOT_TRACK", "true"],
    ["MCPJAM_TELEMETRY_DISABLED", "1"],
    ["MCPJAM_TELEMETRY_DISABLED", "true"],
  ])("sends nothing when %s=%s", async (key, value) => {
    process.env[key] = value;
    await telemetry.captureConformanceRun("sdk", RUN);
    expect(network).not.toHaveBeenCalled();
  });

  it("tries once and never rejects when the network fails", async () => {
    network.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(telemetry.captureConformanceRun("sdk", RUN)).resolves.toBeUndefined();
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("drops a run_source the SDK never sends, and leaks nothing", async () => {
    const event = (run_source: unknown) => ({
      event: "conformance_run_triggered",
      distinct_id: "PRIVATE_SENTINEL",
      properties: { run_source, $current_url: "PRIVATE_SENTINEL" },
    });
    await telemetry.sdkAnalyticsTransport("https://us.i.posthog.com/batch/", {
      method: "POST",
      headers: {},
      body: JSON.stringify({
        api_key: "PRIVATE_SENTINEL",
        batch: [
          event("ui"),
          event("cli"),
          event("github_action"),
          event(""),
          event(1),
          event(undefined),
          event("sdk"),
        ],
      }),
    });
    expect(network).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(network.mock.calls[0][1].body);
    expect(payload.batch).toHaveLength(1);
    expect(payload.batch[0].properties.run_source).toBe("sdk");
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_SENTINEL");
  });
});

describe("sdk_run_completed", () => {
  it("sends one rebuilt event in a single bounded attempt, on the first finish only", async () => {
    const run = telemetry.startSdkRunTelemetry("suite_file", { iterations: 4 });
    await run.finish("failed");
    await run.finish("errored");
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(sentBatch()).toEqual([
      {
        event: "sdk_run_completed",
        distinct_id: "anonymous",
        timestamp: expect.any(String),
        properties: {
          entry_point: "suite_file",
          outcome: "failed",
          sdk_version: expect.stringMatching(SEMVER),
          is_ci: expect.any(Boolean),
          duration_ms: expect.any(Number),
          iterations: 4,
          $geoip_disable: true,
          $process_person_profile: false,
          $insert_id: expect.stringMatching(/^[a-f0-9-]{36}$/),
        },
      },
    ]);
  });

  it("reports is_ci from the CI environment", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    await telemetry.startSdkRunTelemetry("eval_test").finish("passed");
    expect(sentBatch()[0].properties.is_ci).toBe(true);
    vi.unstubAllEnvs();
  });

  it.each(["DO_NOT_TRACK", "MCPJAM_TELEMETRY_DISABLED"])(
    "sends nothing when %s=1",
    async (key) => {
      process.env[key] = "1";
      await telemetry.startSdkRunTelemetry("server_doctor").finish("passed");
      expect(network).not.toHaveBeenCalled();
    }
  );

  it("drops an event with any field outside the allowlist, and strips unknown fields", async () => {
    const valid = {
      entry_point: "eval_test",
      outcome: "passed",
      sdk_version: "10.6.0",
      is_ci: false,
      duration_ms: 12,
    };
    const event = (properties: Record<string, unknown>) => ({
      event: "sdk_run_completed",
      distinct_id: "PRIVATE_SENTINEL",
      properties,
    });
    await telemetry.sdkAnalyticsTransport("https://us.i.posthog.com/batch/", {
      method: "POST",
      headers: {},
      body: JSON.stringify({
        api_key: "PRIVATE_SENTINEL",
        batch: [
          event({ ...valid, sdk_version: "unknown" }),
          event({ ...valid, sdk_version: "PRIVATE_SENTINEL" }),
          event({ ...valid, entry_point: "host_runner" }),
          event({ ...valid, outcome: "ok" }),
          event({ ...valid, is_ci: "true" }),
          event({ ...valid, duration_ms: -1 }),
          event({ ...valid, duration_ms: 1.5 }),
          event({ ...valid, iterations: 0 }),
          event({ ...valid, error: "PRIVATE_SENTINEL", $current_url: "x" }),
        ],
      }),
    });
    expect(network).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(network.mock.calls[0][1].body);
    expect(payload.batch).toHaveLength(1);
    expect(Object.keys(payload.batch[0].properties).sort()).toEqual(
      [
        ...Object.keys(valid),
        "$geoip_disable",
        "$insert_id",
        "$process_person_profile",
      ].sort()
    );
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_SENTINEL");
  });

  it("keeps the older events when their optional fields are invalid", async () => {
    await telemetry.sdkAnalyticsTransport("https://us.i.posthog.com/batch/", {
      method: "POST",
      headers: {},
      body: JSON.stringify({
        api_key: "k",
        batch: [
          {
            event: "eval_test_run_triggered",
            properties: { iterations: 1, concurrency: 1, sdk_version: "unknown" },
          },
          {
            event: "conformance_run_triggered",
            properties: {
              run_source: "sdk",
              suite: "PRIVATE_SENTINEL",
              mode: "batch",
              sdk_version: "1.2.3",
            },
          },
        ],
      }),
    });
    const [evalRun, conformance] = sentBatch();
    expect(evalRun.properties).not.toHaveProperty("sdk_version");
    expect(conformance.properties).not.toHaveProperty("suite");
    expect(conformance.properties).not.toHaveProperty("mode");
    expect(conformance.properties.sdk_version).toBe("1.2.3");
  });
});
