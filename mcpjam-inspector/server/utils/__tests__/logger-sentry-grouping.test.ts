import { afterEach, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";
import type { Envelope } from "@sentry/core";
import { telemetryRecord } from "@mcpjam/sdk/internal/telemetry";
import { withSentryBoundary } from "../../../shared/strict-sentry.js";
import { strictServerSentryOptions } from "../strict-sentry-options.js";
import { logger } from "../logger.js";

afterEach(async () => {
  await Sentry.close(1000);
  vi.unstubAllEnvs();
});

it("groups real logger captures by approved messages while denying runtime prose", async () => {
  vi.stubEnv("AXIOM_TOKEN", "");
  vi.stubEnv("DO_NOT_TRACK", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ENVIRONMENT", "test");
  const events: Record<string, unknown>[] = [];
  Sentry.init({
    dsn: "https://public@example.invalid/1",
    defaultIntegrations: false,
    transport: () =>
      withSentryBoundary(
        {
          send: async (envelope: Envelope) => {
            for (const [header, payload] of envelope[1])
              if (header.type === "event")
                events.push(telemetryRecord(payload));
            return { statusCode: 200 };
          },
          flush: async () => true,
        },
        strictServerSentryOptions,
        () => false,
      ),
  });
  const first = "[host-runtime-config] network error";
  const second = "[computers] runtime-config bootstrap returned non-JSON";
  logger.error(first);
  logger.error(second);
  logger.error(`${first}: PRIVATE_SENTINEL`);
  await Sentry.flush(1000);

  expect(events).toHaveLength(3);
  expect(events[0]).toMatchObject({ message: first });
  expect(events[1]).toMatchObject({ message: second });
  expect(events.map((event) => event.fingerprint)).toEqual([
    ["Error", first, expect.stringMatching(/server\/utils\/logger.ts:\d+$/)],
    ["Error", second, expect.stringMatching(/server\/utils\/logger.ts:\d+$/)],
    ["Error", expect.stringMatching(/server\/utils\/logger.ts:\d+$/)],
  ]);
  const locations = events.map((event) =>
    Array.isArray(event.fingerprint) ? event.fingerprint.at(-1) : undefined,
  );
  expect(new Set(locations).size).toBe(1);
  expect(JSON.stringify(events)).not.toContain("PRIVATE_SENTINEL");
});
