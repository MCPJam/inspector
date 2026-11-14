/**
 * Print the vendor containment settings generated from the credential-URL
 * registry. Prints only — applying them changes production vendor settings
 * and is done by a person (see README.md).
 *
 *   node ops/telemetry-containment/build.mts posthog-blocklist
 *   node ops/telemetry-containment/build.mts sentry-pii
 *   node ops/telemetry-containment/build.mts posthog-transformation
 */
import {
  buildPostHogTransformation,
  buildPostHogUrlBlocklist,
  buildSentryPiiConfig,
} from "./configs.mts";

const which = process.argv[2];
switch (which) {
  case "posthog-blocklist":
    process.stdout.write(
      `${JSON.stringify({ session_recording_url_blocklist_config: buildPostHogUrlBlocklist() }, null, 2)}\n`,
    );
    break;
  case "sentry-pii":
    process.stdout.write(
      `${JSON.stringify(buildSentryPiiConfig(), null, 2)}\n`,
    );
    break;
  case "posthog-transformation":
    process.stdout.write(buildPostHogTransformation());
    break;
  default:
    process.stderr.write(
      "usage: build.mts posthog-blocklist | sentry-pii | posthog-transformation\n",
    );
    process.exit(2);
}
