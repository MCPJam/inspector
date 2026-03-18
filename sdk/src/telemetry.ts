import { PostHog } from "posthog-node";

const isTelemetryDisabled =
  process.env.DO_NOT_TRACK === "1" ||
  process.env.MCPJAM_TELEMETRY_DISABLED === "1";

const noopPosthog = {
  capture: () => {},
  flush: async () => {},
  shutdown: async () => {},
} as unknown as PostHog;

export const posthog: PostHog = isTelemetryDisabled
  ? noopPosthog
  : new PostHog("phc_dTOPniyUNU2kD8Jx8yHMXSqiZHM8I91uWopTMX6EBE9", {
      host: "https://us.i.posthog.com",
    });
