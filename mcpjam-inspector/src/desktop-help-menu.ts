import type { MenuItemConstructorOptions } from "electron";

/** How long Help > Copy Diagnostics waits for the local server. */
export const HELP_PROBE_TIMEOUT_MS = 3_000;

export type LocalServerResult =
  | { result: "ok"; latencyMs: number }
  | { result: "error"; latencyMs: number }
  | { result: "timeout" }
  | { result: "network" }
  | { result: "not_started" };

/** The collector fields this menu copies. Never its activity history. */
export interface DiagnosticsSnapshot {
  run_id?: unknown;
  auth?: unknown;
  startup_stage?: unknown;
  renderer_context_stale?: unknown;
}

export interface DesktopDiagnosticsInput {
  appVersion: string;
  electronVersion: string;
  os: string;
  snapshot: DiagnosticsSnapshot;
  localServer: LocalServerResult;
}

/**
 * Ask the embedded server whether it answers, from the main process, so this
 * works while the window is stuck or its renderer has crashed. Only the outcome
 * and latency are kept: the `/health` body includes the frontend URL.
 */
export async function probeLocalServer(
  serverUrl: string | null,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<LocalServerResult> {
  if (!serverUrl) return { result: "not_started" };
  const started = now();
  try {
    const response = await fetchImpl(new URL("/health", serverUrl), {
      cache: "no-store",
      signal: AbortSignal.timeout(HELP_PROBE_TIMEOUT_MS),
    });
    const latencyMs = now() - started;
    return { result: response.ok ? "ok" : "error", latencyMs };
  } catch (error) {
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

function describeLocalServer(check: LocalServerResult): string {
  switch (check.result) {
    case "ok":
      return `reachable, ${check.latencyMs} ms`;
    case "error":
      return `responded with an error, ${check.latencyMs} ms`;
    case "timeout":
      return "no answer after 3 s";
    case "network":
      return "not reachable";
    case "not_started":
      return "not started";
  }
}

/** Only typed, closed values: a value of any other shape reads `unknown`. */
function closed(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_/.:-]{1,64}$/i.test(value)
    ? value
    : "unknown";
}

/** The same kind of text the startup recovery card copies, from the desktop side. */
export function desktopDiagnosticsText(input: DesktopDiagnosticsInput): string {
  const { snapshot } = input;
  return [
    "MCPJam desktop diagnostics",
    `Version: ${closed(input.appVersion)}`,
    `Electron: ${closed(input.electronVersion)}`,
    `OS: ${closed(input.os)}`,
    `Startup stage: ${closed(snapshot.startup_stage)}`,
    `Sign-in: ${closed(snapshot.auth)}`,
    `Window: ${snapshot.renderer_context_stale === true ? "not responding" : "responding"}`,
    `Local server: ${describeLocalServer(input.localServer)}`,
    `Run ID: ${closed(snapshot.run_id)}`,
  ].join("\n");
}

/**
 * The Help menu with Copy Diagnostics. Everything it needs is passed in, so
 * `main.ts` only wires it and the composition stays testable without Electron.
 */
export function buildHelpMenu(deps: {
  snapshot: () => DiagnosticsSnapshot;
  serverUrl: () => string | null;
  appVersion: () => string;
  electronVersion: string;
  os: string;
  writeClipboard: (text: string) => void;
  confirm: (message: string) => void;
}): MenuItemConstructorOptions {
  return {
    role: "help",
    submenu: [
      {
        label: "Copy Diagnostics",
        click: async () => {
          const text = desktopDiagnosticsText({
            appVersion: deps.appVersion(),
            electronVersion: deps.electronVersion,
            os: deps.os,
            snapshot: deps.snapshot(),
            localServer: await probeLocalServer(deps.serverUrl()),
          });
          deps.writeClipboard(text);
          deps.confirm(
            "Diagnostics copied. Paste them into your message to support. They leave out emails, tokens, URLs and server names.",
          );
        },
      },
    ],
  };
}
