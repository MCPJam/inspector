/**
 * Runtime lifecycle metrics: did updates install, start and stay up?
 *
 * Most of what is measured here happens with nobody watching — a boot
 * prefetch, a background update — so these are SERVER events, and they carry
 * the actor of the last signed-in request this process served when there was
 * one. With none (a boot prefetch before anyone has used this Inspector), an
 * event is captured PERSONLESS under a per-process id: still counted in the
 * failure rate the #mcpjam-alerts block watches, never attached to a person.
 *
 * Content-free by the analytics registry's rule: enums, versions, durations
 * and counts. Never a digest, a path, a machine id or an installer message.
 */
import { randomUUID } from "node:crypto";
import { captureServerEventForActor } from "../../analytics.js";
import { logger } from "../../logger.js";
import type { ServerAnalyticsEventName } from "@/shared/analytics-events";

export type LocalRuntimeEvent = Extract<ServerAnalyticsEventName, `local_runtime_${string}`>;

export interface LocalRuntimeEventProperties {
  harness_id: string;
  pack_version?: string;
  trigger?: string;
  stage?: string;
  reason?: string;
  role?: string;
  duration_ms?: number;
}

let actorDistinctId: string | null = null;
const anonymousId = `local-runtime-${randomUUID()}`;

/** The WorkOS subject of a signed-in request — the client's own actor key. */
export function noteRuntimeMetricsActor(distinctId: string | null | undefined): void {
  if (distinctId) actorDistinctId = distinctId;
}

type Sink = (event: LocalRuntimeEvent, properties: Record<string, unknown>, distinctId: string) => void;
let sink: Sink | null = null;

/** Test seam: capture what would be sent. */
export function setRuntimeMetricsSinkForTests(next: Sink | null): void {
  sink = next;
}

export function emitLocalRuntimeEvent(event: LocalRuntimeEvent, properties: LocalRuntimeEventProperties): void {
  const personless = actorDistinctId === null;
  const props: Record<string, unknown> = {
    ...properties,
    ...(personless ? { $process_person_profile: false } : {}),
  };
  const distinctId = actorDistinctId ?? anonymousId;
  try {
    if (sink !== null) {
      sink(event, props, distinctId);
      return;
    }
    logger.info(`[local-harness] ${event}`, { ...properties });
    // A unit test exercising an install must not ship an event to PostHog.
    if (process.env.VITEST) return;
    captureServerEventForActor({ distinctId }, event, props);
  } catch {
    // Metrics never break an install or a launch.
  }
}
