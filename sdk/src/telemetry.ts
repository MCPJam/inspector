import { randomUUID } from "node:crypto";
import { PostHog, type PostHogOptions } from "posthog-node";
import { sdkTelemetryDisabled } from "./internal/sentry-boundary.js";
import { telemetryRecord } from "./internal/telemetry.js";
import type { ConformanceRunSource } from "./report-conformance-run.js";

const HOST = "https://us.i.posthog.com";
const TOKEN = "phc_dTOPniyUNU2kD8Jx8yHMXSqiZHM8I91uWopTMX6EBE9";
const CONFORMANCE_SEND_TIMEOUT_MS = 3_000;
let client: PostHog | undefined;

/**
 * The only `run_source` labels the SDK sends: `sdk` for direct use (also in
 * CI), the rest for the Inspector's hosted runs. The CLI and the app send
 * their own labels from their own clients.
 */
const SDK_CONFORMANCE_RUN_SOURCES = [
  "sdk",
  "api",
  "github_app",
  "benchmark",
] as const satisfies readonly ConformanceRunSource[];
export type SdkConformanceRunSource =
  (typeof SDK_CONFORMANCE_RUN_SOURCES)[number];

function conformanceRunProperties(value: unknown) {
  const { run_source } = telemetryRecord(value);
  return typeof run_source === "string" &&
    (SDK_CONFORMANCE_RUN_SOURCES as readonly string[]).includes(run_source)
    ? { run_source }
    : null;
}

function runProperties(value: unknown) {
  const { iterations, concurrency } = telemetryRecord(value);
  if (
    typeof iterations !== "number" ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > 1000000 ||
    typeof concurrency !== "number" ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 1024
  )
    return null;
  return { iterations, concurrency };
}

/** Rebuild retries too: no library-added properties or old opt-out state escape. */
export const sdkAnalyticsTransport: NonNullable<
  PostHogOptions["fetch"]
> = async (url, options) => {
  const dropped = () => new Response("{}", { status: 200 });
  if (
    sdkTelemetryDisabled() ||
    url !== `${HOST}/batch/` ||
    options.method !== "POST" ||
    typeof options.body !== "string"
  )
    return dropped();
  let body: Record<string, unknown>;
  try {
    body = telemetryRecord(JSON.parse(options.body));
  } catch {
    return dropped();
  }
  if (!Array.isArray(body.batch)) return dropped();
  const batch = body.batch.flatMap((raw) => {
    const event = telemetryRecord(raw);
    const name = event.event;
    const properties =
      name === "eval_test_run_triggered"
        ? runProperties(event.properties)
        : name === "conformance_run_triggered"
          ? conformanceRunProperties(event.properties)
          : null;
    if (!properties) return [];
    const insertId = telemetryRecord(event.properties).$insert_id;
    return [
      {
        event: name,
        distinct_id: "anonymous",
        timestamp: new Date().toISOString(),
        properties: {
          ...properties,
          $geoip_disable: true,
          $process_person_profile: false,
          $insert_id:
            typeof insertId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
              insertId
            )
              ? insertId
              : randomUUID(),
        },
      },
    ];
  });
  if (!batch.length) return dropped();
  return fetch(url, {
    method: "POST",
    signal: options.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: TOKEN, batch }),
  });
};

export function captureSdkRun(iterations: unknown, concurrency: unknown): void {
  if (sdkTelemetryDisabled()) return;
  client ??= new PostHog(TOKEN, {
    host: HOST,
    disableCompression: true,
    enableExceptionAutocapture: false,
    fetch: sdkAnalyticsTransport,
  });
  client.capture({
    distinctId: "anonymous",
    event: "eval_test_run_triggered",
    properties: { iterations, concurrency, $insert_id: randomUUID() },
  });
}

/**
 * One anonymous `conformance_run_triggered` ping per top-level run. Every
 * entry point (the four Test classes, the three Suites, `runConformance`)
 * sends one unless its config sets `__suppressTelemetry`. Suites and
 * `runConformance` set it on their inner runs, so one run is one event.
 * Hosts that count the run themselves set it too: the CLI honors
 * `--no-telemetry` and a persisted opt-out, neither of which this module's
 * env check can see, and the Inspector counts UI runs in the browser.
 *
 * It goes straight through the transport in ONE bounded attempt: the queued
 * client loses an event when a short script exits before its 10s flush, and
 * its immediate send retries on plain timers that hold an offline process
 * open. Never throws, never rejects: usage telemetry must not affect a run.
 */
export async function captureConformanceRun(
  runSource: SdkConformanceRunSource
): Promise<void> {
  try {
    if (sdkTelemetryDisabled()) return;
    await sdkAnalyticsTransport(`${HOST}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TOKEN,
        batch: [
          {
            event: "conformance_run_triggered",
            distinct_id: "anonymous",
            properties: { run_source: runSource, $insert_id: randomUUID() },
          },
        ],
      }),
      signal: AbortSignal.timeout(CONFORMANCE_SEND_TIMEOUT_MS),
    });
  } catch {
    // Offline, blocked or timed out: the run goes on without the ping.
  }
}

export async function flushSdkTelemetry(): Promise<void> {
  await client?.flush();
}

export async function shutdownSdkTelemetry(): Promise<void> {
  const previous = client;
  client = undefined;
  await previous?.shutdown();
}
