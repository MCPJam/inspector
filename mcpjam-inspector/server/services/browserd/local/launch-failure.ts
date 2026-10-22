/**
 * What a person should read when the local Browser's Chromium did not start.
 *
 * Every launch failure gets a code the routes can map, so none of them reaches
 * the pane as "Invalid project for the local browser". The sandbox one has its
 * own: AppArmor denies the unprivileged user namespace Chromium's sandbox needs
 * (on by default since Ubuntu 24.04; introduced, off, in 23.10), and the local
 * launch never retries with `--no-sandbox` (see `launchBrowserdContext`), so
 * only the host can fix it. Playwright's banner and Chromium's own line are
 * both in either shape Playwright gives the error; matching both keeps this
 * working if one of them is reworded.
 */
const SANDBOX_FAILURE = /Chromium sandboxing failed!|No usable sandbox!/;

export function describeLaunchFailure(error: unknown): {
  code: "chromium_sandbox_unavailable" | "launch_failed";
  message: string;
} {
  const text = error instanceof Error ? error.message : String(error);
  if (SANDBOX_FAILURE.test(text)) {
    return {
      code: "chromium_sandbox_unavailable",
      message:
        "Chromium can't start its sandbox on this machine. On Ubuntu 23.10 or later, allow AppArmor user namespaces for Playwright's Chromium in ~/.cache/ms-playwright (https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md), then try again.",
    };
  }
  const firstLine = text.split("\n", 1)[0].trim().replace(/\.$/, "");
  return {
    code: "launch_failed",
    message: `Chromium could not start on this machine (${firstLine}). Start the Inspector with --verbose to see the full error, then try again.`,
  };
}
