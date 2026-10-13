import { randomUUID } from "node:crypto";
import { PostHog, type PostHogOptions } from "posthog-node";
import { sdkTelemetryDisabled } from "./internal/sentry-boundary.js";
import { telemetryRecord } from "./internal/telemetry.js";

const HOST = "https://us.i.posthog.com";
const TOKEN = "phc_dTOPniyUNU2kD8Jx8yHMXSqiZHM8I91uWopTMX6EBE9";
let client: PostHog | undefined;

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
    const properties = runProperties(event.properties);
    if (event.event !== "eval_test_run_triggered" || !properties) return [];
    const insertId = telemetryRecord(event.properties).$insert_id;
    return [
      {
        event: "eval_test_run_triggered",
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
  const properties = runProperties({ iterations, concurrency });
  if (sdkTelemetryDisabled() || !properties) return;
  client ??= new PostHog(TOKEN, {
    host: HOST,
    disableCompression: true,
    enableExceptionAutocapture: false,
    fetch: sdkAnalyticsTransport,
  });
  client.capture({
    distinctId: "anonymous",
    event: "eval_test_run_triggered",
    properties: { ...properties, $insert_id: randomUUID() },
  });
}

export async function flushSdkTelemetry(): Promise<void> {
  await client?.flush();
}

export async function shutdownSdkTelemetry(): Promise<void> {
  const previous = client;
  client = undefined;
  await previous?.shutdown();
}
