import type { AppLoadStallCode } from "@/shared/app-load-stall";
import type { SessionRefreshFailureKind } from "@/stores/session-refresh-store";
import { HOSTED_MODE } from "./config";
import { detectPlatform } from "./PosthogUtils";

/** How long the recovery card waits for the local server before saying so. */
export const LOCAL_SERVER_PROBE_TIMEOUT_MS = 3_000;

export type LocalServerCheck =
  | { result: "pending" }
  | { result: "not_applicable" }
  | { result: "ok"; latencyMs: number }
  | { result: "http_error"; status: number; latencyMs: number }
  | { result: "timeout" }
  | { result: "network" };

/**
 * What the recovery card copies for support. Every field is a closed value or
 * a number: no error messages, URLs, emails, tokens or server names, so the
 * text is safe to paste anywhere.
 */
export interface StartupDiagnostics {
  version: string;
  platform: string;
  stage: AppLoadStallCode;
  refreshFailure: SessionRefreshFailureKind | "none";
  localServer: LocalServerCheck;
  secondsSinceStart: number;
}

/**
 * Ask this tab's own server whether it answers. Only the status and latency
 * are kept: the `/health` body includes the frontend URL. The hosted app has no
 * local server to ask.
 */
export async function probeLocalServer(
  fetchImpl: typeof fetch = fetch,
): Promise<LocalServerCheck> {
  if (HOSTED_MODE) return { result: "not_applicable" };
  const started = performance.now();
  try {
    const response = await fetchImpl("/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(LOCAL_SERVER_PROBE_TIMEOUT_MS),
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) {
      return { result: "http_error", status: response.status, latencyMs };
    }
    // A dev server can answer any path with the app's HTML; only the local
    // server's own health body means it is up.
    return (await isHealthBody(response))
      ? { result: "ok", latencyMs }
      : { result: "network" };
  } catch (error) {
    // A DOMException is not an Error in every runtime; read its name directly.
    const name =
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      typeof error.name === "string"
        ? error.name
        : "";
    return name === "TimeoutError" || name === "AbortError"
      ? { result: "timeout" }
      : { result: "network" };
  }
}

async function isHealthBody(response: Response): Promise<boolean> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    return false;
  }
  const body: unknown = await response.json();
  return (
    typeof body === "object" &&
    body !== null &&
    "status" in body &&
    body.status === "ok"
  );
}

export function buildStartupDiagnostics(input: {
  stage: AppLoadStallCode;
  failureKind: SessionRefreshFailureKind | null;
  localServer: LocalServerCheck;
}): StartupDiagnostics {
  return {
    version: __APP_VERSION__,
    platform: detectPlatform(),
    stage: input.stage,
    refreshFailure: input.failureKind ?? "none",
    localServer: input.localServer,
    secondsSinceStart:
      typeof performance === "undefined"
        ? 0
        : Math.round(performance.now() / 1000),
  };
}

function describeLocalServer(check: LocalServerCheck): string {
  switch (check.result) {
    case "pending":
      return "checking";
    case "not_applicable":
      return "not applicable";
    case "ok":
      return `reachable, ${check.latencyMs} ms`;
    case "http_error":
      return `responded with an error, ${check.latencyMs} ms`;
    case "timeout":
      return "no answer after 3 s";
    case "network":
      return "not reachable";
  }
}

/** Label and value pairs, in the order the card lists them. */
export function diagnosticsRows(
  d: StartupDiagnostics,
): Array<[string, string]> {
  return [
    ["Version", d.version],
    ["Platform", d.platform],
    ["Startup stage", d.stage],
    ["Session refresh", d.refreshFailure],
    ["Local server", describeLocalServer(d.localServer)],
    ["Time since start", `${d.secondsSinceStart} s`],
  ];
}

export function diagnosticsText(d: StartupDiagnostics): string {
  return [
    "MCPJam startup diagnostics",
    ...diagnosticsRows(d).map(([label, value]) => `${label}: ${value}`),
  ].join("\n");
}
