import { randomUUID } from "node:crypto";
import { PostHog, type PostHogOptions } from "posthog-node";
import { detectEvalCiMetadata } from "./eval-ci.js";
import { sdkTelemetryDisabled } from "./internal/sentry-boundary.js";
import { telemetryRecord } from "./internal/telemetry.js";
import type { ConformanceRunSource } from "./report-conformance-run.js";
import { readSdkVersion } from "./sdk-version.js";

const HOST = "https://us.i.posthog.com";
const TOKEN = "phc_dTOPniyUNU2kD8Jx8yHMXSqiZHM8I91uWopTMX6EBE9";
const CONFORMANCE_SEND_TIMEOUT_MS = 3_000;
const SEMVER =
  /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;
/** A week: longer than any run, short enough to reject garbage. */
const MAX_RUN_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
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

const CONFORMANCE_SUITES = [
  "protocol",
  "oauth",
  "apps",
  "tasks",
  "events",
  "run",
] as const;
/** Which conformance family ran. `run` is `runConformance`, which mixes them. */
export type ConformanceSuiteName = (typeof CONFORMANCE_SUITES)[number];
/** One test, or a suite of several. */
export type ConformanceRunMode = "single" | "suite";

const SDK_RUN_ENTRY_POINTS = ["eval_test", "suite_file", "server_doctor"] as const;
export type SdkRunEntryPoint = (typeof SDK_RUN_ENTRY_POINTS)[number];
const SDK_RUN_OUTCOMES = ["passed", "failed", "errored", "aborted"] as const;
export type SdkRunOutcome = (typeof SDK_RUN_OUTCOMES)[number];

function oneOf<T extends string>(
  allowed: readonly T[],
  value: unknown
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isBoundedInteger(value: unknown, min: number, max: number) {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** A valid `sdk_version`, or nothing. Never fails the event it rides on. */
function versionProperty(value: unknown) {
  return typeof value === "string" && SEMVER.test(value)
    ? { sdk_version: value }
    : {};
}

function conformanceRunProperties(value: unknown) {
  const { run_source, suite, mode, sdk_version } = telemetryRecord(value);
  if (!oneOf(SDK_CONFORMANCE_RUN_SOURCES, run_source)) return null;
  return {
    run_source,
    ...(oneOf(CONFORMANCE_SUITES, suite) ? { suite } : {}),
    ...(mode === "single" || mode === "suite" ? { mode } : {}),
    ...versionProperty(sdk_version),
  };
}

/** Every field is required and checked; one bad field drops the event. */
function runCompletedProperties(value: unknown) {
  const { entry_point, outcome, sdk_version, is_ci, duration_ms, iterations } =
    telemetryRecord(value);
  if (
    !oneOf(SDK_RUN_ENTRY_POINTS, entry_point) ||
    !oneOf(SDK_RUN_OUTCOMES, outcome) ||
    typeof sdk_version !== "string" ||
    !SEMVER.test(sdk_version) ||
    typeof is_ci !== "boolean" ||
    !isBoundedInteger(duration_ms, 0, MAX_RUN_DURATION_MS) ||
    (iterations !== undefined && !isBoundedInteger(iterations, 1, 1000000))
  )
    return null;
  return {
    entry_point,
    outcome,
    sdk_version,
    is_ci,
    duration_ms,
    ...(iterations === undefined ? {} : { iterations }),
  };
}

function runProperties(value: unknown) {
  const { iterations, concurrency, sdk_version } = telemetryRecord(value);
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
  return { iterations, concurrency, ...versionProperty(sdk_version) };
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
          : name === "sdk_run_completed"
            ? runCompletedProperties(event.properties)
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
    properties: {
      iterations,
      concurrency,
      sdk_version: readSdkVersion(),
      $insert_id: randomUUID(),
    },
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
 * It goes straight through the transport in ONE bounded attempt: see
 * `sendOnce`. Never throws, never rejects: usage telemetry must not affect a
 * run.
 */
export async function captureConformanceRun(
  runSource: SdkConformanceRunSource,
  run: { suite: ConformanceSuiteName; mode: ConformanceRunMode }
): Promise<void> {
  await sendOnce("conformance_run_triggered", {
    run_source: runSource,
    suite: run.suite,
    mode: run.mode,
    sdk_version: readSdkVersion(),
  });
}

export interface SdkRunTelemetry {
  /** Send `sdk_run_completed`. Only the first call sends; later ones do nothing. */
  finish(outcome: SdkRunOutcome): Promise<void>;
}

/**
 * Start timing one top-level SDK run, for one `sdk_run_completed` when it
 * ends. Call `finish` with the result's outcome, and again from a `finally`
 * with `errored` or `aborted`: the first call wins, so a thrown run is still
 * counted. Hosts that count runs themselves (the CLI) don't start one.
 */
export function startSdkRunTelemetry(
  entryPoint: SdkRunEntryPoint,
  options: { iterations?: number } = {}
): SdkRunTelemetry {
  const startedAt = Date.now();
  let finished = false;
  return {
    async finish(outcome) {
      if (finished) return;
      finished = true;
      await sendOnce("sdk_run_completed", {
        entry_point: entryPoint,
        outcome,
        sdk_version: readSdkVersion(),
        is_ci: detectEvalCiMetadata(process.env) !== undefined,
        duration_ms: Math.max(0, Date.now() - startedAt),
        ...(options.iterations === undefined
          ? {}
          : { iterations: options.iterations }),
      });
    },
  };
}

/**
 * One event straight through the transport, in ONE bounded attempt. The
 * queued client loses an event when a short script exits before its 10s
 * flush, and its immediate send retries on plain timers that hold an offline
 * process open. Never throws, never rejects.
 */
async function sendOnce(
  event: string,
  properties: Record<string, unknown>
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
            event,
            distinct_id: "anonymous",
            properties: { ...properties, $insert_id: randomUUID() },
          },
        ],
      }),
      signal: AbortSignal.timeout(CONFORMANCE_SEND_TIMEOUT_MS),
    });
  } catch {
    // Offline, blocked or timed out: the run goes on without the event.
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
