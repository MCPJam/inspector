import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function notification(report, previous = {}, now = Date.now()) {
  const failed = report.results
    .filter((r) => r.outcome !== "passed")
    .map((r) => r.name)
    .sort();
  if (report.coverageFailure) failed.push("monitor.configuration");
  if (!report.passed && !failed.length) failed.push("monitor.incomplete");
  const fingerprint = failed.join(",");
  const changed = fingerprint !== previous.fingerprint;
  const recovered = !fingerprint && !!previous.fingerprint;
  const send =
    recovered ||
    (!!fingerprint &&
      (changed || now - (previous.notifiedAt || 0) >= 30 * 60_000));
  const state = {
    fingerprint,
    notifiedAt: send ? now : previous.notifiedAt || 0,
  };
  return {
    send,
    state,
    text: recovered
      ? "MCPJam reliability recovered: hosted and npm saved-credential checks pass."
      : `MCPJam reliability check failed: ${failed.join(
          ", "
        )}. Inspect the linked report; a synthetic failure is not an estimate of affected customers.`,
  };
}

export async function postSlack(webhook, text, fetchImpl = fetch) {
  const url = new URL(webhook);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "hooks.slack.com" ||
    !url.pathname.startsWith("/services/")
  )
    throw new Error("Invalid Slack webhook configuration");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, unfurl_links: false }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok || (await response.text()).trim() !== "ok")
    throw new Error("Slack delivery failed");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let report;
  try {
    report = JSON.parse(readFileSync("reliability-report.json", "utf8"));
  } catch {
    report = { passed: false, coverageFailure: true, results: [] };
  }
  let previous = {};
  try {
    previous = JSON.parse(
      readFileSync(".reliability-state/state.json", "utf8")
    );
  } catch {
    /* first run */
  }
  const alert = notification(report, previous);
  try {
    // Required even on healthy runs: don't silently discover missing routing
    // only after the product fails. Never persist a delivered state on error.
    if (!process.env.SLACK_ALERTS_WEBHOOK_URL)
      throw new Error("Slack webhook missing");
    if (alert.send)
      await postSlack(
        process.env.SLACK_ALERTS_WEBHOOK_URL,
        `${alert.text}\n${process.env.RUN_URL}`
      );
    writeFileSync(".reliability-state/state.json", JSON.stringify(alert.state));
  } catch {
    process.stderr.write(
      "Reliability alert delivery is unavailable. See run report; notification state was not advanced.\n"
    );
    process.exitCode = 1;
  }
}
