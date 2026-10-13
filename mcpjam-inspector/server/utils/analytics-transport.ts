import type { PostHogOptions } from "posthog-node";
import { randomUUID } from "node:crypto";
import { telemetryRecord } from "@mcpjam/sdk/internal/telemetry";
import {
  rebuildServerAnalytics,
  rolloutActorId,
  rolloutPersonProperties,
} from "../../shared/strict-server-analytics.js";

/** Check queued retries at the last network boundary as well as at capture. */
export function analyticsTransport(
  host: string,
  token: string,
  disabled: () => boolean,
): NonNullable<PostHogOptions["fetch"]> {
  return async (url, options) => {
    const dropped = () => new Response("{}", { status: 200 });
    if (options.method !== "POST" || typeof options.body !== "string")
      return dropped();
    let body: Record<string, unknown>;
    try {
      body = telemetryRecord(JSON.parse(options.body));
    } catch {
      return dropped();
    }
    if (url === `${host}/batch/`) {
      if (disabled() || !Array.isArray(body.batch)) return dropped();
      const batch = rebuildBatch(body.batch);
      if (!batch.length) return dropped();
      body = { api_key: token, batch };
    } else if (url === `${host}/flags/?v=2`) {
      const distinctId = rolloutActorId(body.distinct_id);
      if (!distinctId) return dropped();
      body = {
        token,
        distinct_id: distinctId,
        groups: {},
        group_properties: {},
        person_properties: rolloutPersonProperties(
          telemetryRecord(body.person_properties) as Record<string, string>,
        ),
      };
    } else return dropped();
    return fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  };
}

function rebuildBatch(rawBatch: unknown[]) {
  return rawBatch.flatMap((raw) => {
    const event = telemetryRecord(raw);
    const props = telemetryRecord(event.properties);
    const rebuilt = rebuildServerAnalytics(
      String(event.event),
      event.distinct_id,
      props,
    );
    if (!rebuilt) return [];
    return [
      {
        event: rebuilt.event,
        distinct_id: rebuilt.distinctId,
        timestamp: new Date().toISOString(),
        properties: {
          ...rebuilt.properties,
          $geoip_disable: true,
          $insert_id:
            typeof props.$insert_id === "string" &&
            /^[0-9a-f-]{36}$/.test(props.$insert_id)
              ? props.$insert_id
              : randomUUID(),
          source: "server",
          platform: ["web", "npm", "electron"].includes(String(props.platform))
            ? props.platform
            : "npm",
          environment: [
            "prod",
            "dev",
            "staging",
            "preview",
            "local",
            "test",
          ].includes(String(props.environment))
            ? props.environment
            : "dev",
          deployment: props.deployment === "hosted" ? "hosted" : "self_hosted",
        },
      },
    ];
  });
}
