import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { PostHog } from "posthog-node";
import {
  getUpdateCacheDir,
  type CachePathOptions,
  type StderrLike,
} from "./update-notifier.js";

const POSTHOG_KEY = "phc_dTOPniyUNU2kD8Jx8yHMXSqiZHM8I91uWopTMX6EBE9";
const POSTHOG_HOST = "https://us.i.posthog.com";
const TELEMETRY_STATE_FILE = "telemetry.json";
const TELEMETRY_EVENT_NAME = "cli_command";
const TELEMETRY_STATE_VERSION = 1;
const DEFAULT_FLUSH_TIMEOUT_MS = 3_000;

const SAFE_ERROR_CODES = new Set([
  "USAGE_ERROR",
  "TIMEOUT",
  "AUTH_FAILED",
  "TRANSPORT_ERROR",
  "SERVER_ERROR",
  "NETWORK_ERROR",
  "UNKNOWN_ERROR",
]);

export type TelemetryDisableReason =
  | "--no-telemetry"
  | "DO_NOT_TRACK"
  | "MCPJAM_TELEMETRY_DISABLED"
  | "state";

export type TelemetryTransport = "http" | "stdio";

export interface TelemetryState {
  version: 1;
  enabled: boolean;
  installId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TelemetryStatus {
  enabled: boolean;
  installId: string | null;
  installIdCreated: boolean;
  stateFile: string;
  debugMode: boolean;
  disableReason: TelemetryDisableReason | null;
}

export interface TelemetryEvent {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
}

export interface TelemetryClient {
  capture(event: TelemetryEvent): void | Promise<void>;
  flush(timeoutMs?: number): Promise<void>;
}

export interface TelemetryOptions extends CachePathOptions {
  statePath?: string;
  env?: NodeJS.ProcessEnv;
  stderr?: StderrLike;
  createClient?: () => TelemetryClient;
  createId?: () => string;
  now?: () => Date;
  flushTimeoutMs?: number;
}

export interface TelemetryController {
  flush(): Promise<void>;
}

interface TelemetryDecision {
  enabled: boolean;
  disableReason: TelemetryDisableReason | null;
  state: TelemetryState | null;
  stateFile: string;
  debugMode: boolean;
}

interface ActiveTelemetryRun {
  cliVersion: string;
  options: TelemetryOptions;
  command?: string;
  commandOptOut: boolean;
  startedAtMs?: number;
  transport?: TelemetryTransport;
  shouldCapture: boolean;
  captured: boolean;
  pendingCaptures: Promise<void>[];
  client?: TelemetryClient;
  fallbackInstallId?: string;
}

let activeRun: ActiveTelemetryRun | null = null;

export function getTelemetryStatePath(options: TelemetryOptions = {}): string {
  return options.statePath ?? join(getUpdateCacheDir(options), TELEMETRY_STATE_FILE);
}

export function readTelemetryState(
  options: TelemetryOptions = {},
): TelemetryState | null {
  try {
    const payload = JSON.parse(readFileSync(getTelemetryStatePath(options), "utf8"));
    return parseTelemetryState(payload);
  } catch {
    return null;
  }
}

export function getTelemetryStatus(
  options: TelemetryOptions & { commandOptOut?: boolean } = {},
): TelemetryStatus {
  const decision = resolveTelemetryDecision({
    ...options,
    commandOptOut: options.commandOptOut ?? false,
  });

  return {
    enabled: decision.enabled,
    installId: decision.state?.installId ?? null,
    installIdCreated: Boolean(decision.state?.installId),
    stateFile: decision.stateFile,
    debugMode: decision.debugMode,
    disableReason: decision.disableReason,
  };
}

export function setTelemetryEnabled(
  enabled: boolean,
  options: TelemetryOptions = {},
): TelemetryState {
  const stateFile = getTelemetryStatePath(options);
  const existing = readTelemetryState(options);
  const now = getNow(options);
  const createdAt = existing?.createdAt ?? now;
  const installId = enabled
    ? existing?.installId ?? createInstallId(options)
    : existing?.installId;
  const nextState: TelemetryState = {
    version: TELEMETRY_STATE_VERSION,
    enabled,
    ...(installId ? { installId } : {}),
    createdAt,
    updatedAt: now,
  };

  writeTelemetryState(stateFile, nextState);
  return nextState;
}

export function formatTelemetryStatusHuman(status: TelemetryStatus): string {
  const lines = [
    `Telemetry: ${status.enabled ? "enabled" : "disabled"}`,
    `Install ID: ${status.installId ?? "not created yet"}`,
    `State file: ${status.stateFile}`,
    `Debug mode: ${status.debugMode ? "on" : "off"}`,
  ];

  if (status.disableReason) {
    lines.push(`Disable reason: ${status.disableReason}`);
  }

  return `${lines.join("\n")}\n`;
}

export function initTelemetry(
  program: Command,
  cliVersion: string,
  options: TelemetryOptions = {},
): TelemetryController {
  const run: ActiveTelemetryRun = {
    cliVersion,
    options,
    commandOptOut: false,
    shouldCapture: false,
    captured: false,
    pendingCaptures: [],
  };
  activeRun = run;

  program.hook("preAction", (_thisCommand, actionCommand) => {
    if (activeRun !== run) {
      return;
    }

    const commandPath = getCommandPath(actionCommand);
    run.command = commandPath.join(" ");
    run.commandOptOut = isCommandTelemetryOptedOut(actionCommand);
    run.startedAtMs = Date.now();
    run.transport = detectTransport(actionCommand);
    run.shouldCapture = commandPath[0] !== "telemetry";
    run.captured = false;
  });

  return {
    async flush() {
      const client = run.client;
      if (!client) {
        return;
      }

      try {
        const timeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
        await withTimeout(
          flushClient(run, client, timeoutMs),
          timeoutMs,
        );
      } catch {
        // Telemetry is best-effort and must never affect CLI behavior.
      }
    },
  };
}

async function flushClient(
  run: ActiveTelemetryRun,
  client: TelemetryClient,
  timeoutMs: number,
): Promise<void> {
  const pendingCaptures = run.pendingCaptures.splice(0);
  if (pendingCaptures.length > 0) {
    await Promise.allSettled(pendingCaptures);
  }

  await client.flush(timeoutMs);
}

export function captureCommandEvent(
  exitCode: number,
  errorCode?: string,
): void {
  const run = activeRun;
  if (
    !run ||
    !run.shouldCapture ||
    run.captured ||
    !run.startedAtMs ||
    !run.command
  ) {
    return;
  }

  run.captured = true;

  try {
    const decision = resolveTelemetryDecision({
      ...run.options,
      commandOptOut: run.commandOptOut,
    });

    if (!decision.enabled) {
      return;
    }

    const distinctId = resolveInstallId(run, decision.state);
    const isCiRun = isCi(run.options.env);
    const properties: Record<string, unknown> = {
      platform: "cli",
      command: run.command,
      success: exitCode === 0,
      exit_code: exitCode,
      duration_ms: Math.max(0, Date.now() - run.startedAtMs),
      cli_version: run.cliVersion,
      os: process.platform,
      arch: process.arch,
      node_version: process.version,
      is_ci: isCiRun,
    };

    if (isCiRun) {
      properties.ci_name = detectCiName(run.options.env);
    }

    if (run.transport) {
      properties.transport = run.transport;
    }

    const safeErrorCode =
      exitCode === 0 ? undefined : normalizeTelemetryErrorCode(errorCode);
    if (safeErrorCode) {
      properties.error_code = safeErrorCode;
    }

    if (decision.debugMode) {
      writeDebugPayload(run.options, distinctId, properties);
      return;
    }

    const client = getOrCreateClient(run);
    const pendingCapture = client.capture({
      distinctId,
      event: TELEMETRY_EVENT_NAME,
      properties,
    });
    if (pendingCapture) {
      run.pendingCaptures.push(pendingCapture.catch(() => {}));
    }
  } catch {
    // Telemetry is best-effort and must never affect CLI behavior.
  }
}

function resolveTelemetryDecision(
  options: TelemetryOptions & { commandOptOut: boolean },
): TelemetryDecision {
  const stateFile = getTelemetryStatePath(options);
  const state = readTelemetryState(options);
  const envDisableReason = getEnvDisableReason(options.env);
  const disableReason = options.commandOptOut
    ? "--no-telemetry"
    : envDisableReason ?? (state?.enabled === false ? "state" : null);

  return {
    enabled: disableReason === null,
    disableReason,
    state,
    stateFile,
    debugMode: isDebugMode(options.env),
  };
}

function getEnvDisableReason(
  env: NodeJS.ProcessEnv = process.env,
): TelemetryDisableReason | null {
  if (env.DO_NOT_TRACK === "1") {
    return "DO_NOT_TRACK";
  }

  if (env.MCPJAM_TELEMETRY_DISABLED === "1") {
    return "MCPJAM_TELEMETRY_DISABLED";
  }

  return null;
}

function resolveInstallId(
  run: ActiveTelemetryRun,
  state: TelemetryState | null,
): string {
  if (state?.installId) {
    return state.installId;
  }

  try {
    const nextState = setTelemetryEnabled(true, run.options);
    if (nextState.installId) {
      return nextState.installId;
    }
  } catch {
    // Fall through to a per-run id if cache writes fail.
  }

  run.fallbackInstallId ??= createInstallId(run.options);
  return run.fallbackInstallId;
}

function getOrCreateClient(run: ActiveTelemetryRun): TelemetryClient {
  run.client ??=
    run.options.createClient?.() ??
    new PostHogTelemetryClient(
      new PostHog(POSTHOG_KEY, {
        host: POSTHOG_HOST,
      }),
    );
  return run.client;
}

class PostHogTelemetryClient implements TelemetryClient {
  constructor(private readonly client: PostHog) {}

  capture(event: TelemetryEvent): Promise<void> {
    return this.client.captureImmediate(event);
  }

  async flush(timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    await this.client.shutdown(timeoutMs);
  }
}

function writeDebugPayload(
  options: TelemetryOptions,
  distinctId: string,
  properties: Record<string, unknown>,
): void {
  const stderr = options.stderr ?? process.stderr;
  stderr.write(
    `MCPJam telemetry debug: ${JSON.stringify({
      event: TELEMETRY_EVENT_NAME,
      distinct_id: distinctId,
      properties,
    })}\n`,
  );
}

function getCommandPath(actionCommand: Command): string[] {
  const names: string[] = [];
  let current: Command | null = actionCommand;

  while (current) {
    const name = current.name();
    if (name && name !== "mcpjam") {
      names.unshift(name);
    }
    current = current.parent ?? null;
  }

  return names;
}

function isCommandTelemetryOptedOut(actionCommand: Command): boolean {
  const options = actionCommand.optsWithGlobals() as { telemetry?: unknown };
  return options.telemetry === false;
}

function detectTransport(actionCommand: Command): TelemetryTransport | undefined {
  const options = actionCommand.optsWithGlobals() as Record<string, unknown>;

  if (typeof options.url === "string" && options.url.trim().length > 0) {
    return "http";
  }

  if (typeof options.command === "string" && options.command.trim().length > 0) {
    return "stdio";
  }

  return undefined;
}

function normalizeTelemetryErrorCode(value: string | undefined): string {
  if (value && SAFE_ERROR_CODES.has(value)) {
    return value;
  }

  if (value === "SERVER_UNREACHABLE") {
    return "NETWORK_ERROR";
  }

  if (value?.includes("AUTH") || value?.includes("UNAUTHORIZED")) {
    return "AUTH_FAILED";
  }

  if (value?.includes("TIMEOUT")) {
    return "TIMEOUT";
  }

  if (value?.includes("TRANSPORT")) {
    return "TRANSPORT_ERROR";
  }

  if (value?.includes("NETWORK") || value?.includes("UNREACHABLE")) {
    return "NETWORK_ERROR";
  }

  if (value?.includes("SERVER")) {
    return "SERVER_ERROR";
  }

  return "UNKNOWN_ERROR";
}

function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.CI ||
      env.GITHUB_ACTIONS ||
      env.GITLAB_CI ||
      env.CIRCLECI ||
      env.BUILDKITE ||
      env.JENKINS_URL ||
      env.JENKINS_HOME ||
      env.VERCEL ||
      env.NETLIFY,
  );
}

function isDebugMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCPJAM_TELEMETRY_DEBUG === "1";
}

function detectCiName(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITHUB_ACTIONS) {
    return "github_actions";
  }
  if (env.GITLAB_CI) {
    return "gitlab_ci";
  }
  if (env.CIRCLECI) {
    return "circleci";
  }
  if (env.BUILDKITE) {
    return "buildkite";
  }
  if (env.JENKINS_URL || env.JENKINS_HOME) {
    return "jenkins";
  }
  if (env.VERCEL) {
    return "vercel";
  }
  if (env.NETLIFY) {
    return "netlify";
  }
  return "unknown";
}

function parseTelemetryState(value: unknown): TelemetryState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const payload = value as Record<string, unknown>;
  if (
    payload.version !== TELEMETRY_STATE_VERSION ||
    typeof payload.enabled !== "boolean" ||
    typeof payload.createdAt !== "string" ||
    typeof payload.updatedAt !== "string"
  ) {
    return null;
  }

  if (
    payload.installId !== undefined &&
    (typeof payload.installId !== "string" || !isValidUuid(payload.installId))
  ) {
    return null;
  }

  return {
    version: TELEMETRY_STATE_VERSION,
    enabled: payload.enabled,
    ...(typeof payload.installId === "string"
      ? { installId: payload.installId }
      : {}),
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
  };
}

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function writeTelemetryState(stateFile: string, state: TelemetryState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  const temporaryPath = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, stateFile);
}

function getNow(options: TelemetryOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}

function createInstallId(options: TelemetryOptions): string {
  return options.createId?.() ?? randomUUID();
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
