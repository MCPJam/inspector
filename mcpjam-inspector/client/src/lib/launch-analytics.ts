import posthog from "posthog-js";
import type { LaunchEngagement } from "@/shared/launch-engagement";
import { track } from "./analytics";
import { isPostHogDisabled } from "./PosthogUtils";

/** Best-effort dual delivery. Respect the same opt-out for both destinations. */
export function trackLaunchEngagement(
  event: Omit<LaunchEngagement, "event_id">,
): void {
  try {
    if (isPostHogDisabled || posthog.has_opted_out_capturing()) return;
    const payload: LaunchEngagement = {
      ...event,
      event_id: crypto.randomUUID(),
    };
    track("platform_launch_engagement", {
      ...payload,
      location: "platform_launch",
    });
    void fetch("/tlm/launch-engagement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
      credentials: "omit",
    }).catch(() => {
      /* Telemetry never interrupts navigation. */
    });
  } catch {
    // Disabled SDKs, storage restrictions, and network failures are non-fatal.
  }
}
