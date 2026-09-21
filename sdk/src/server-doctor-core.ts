import { getExistingAuthorization, normalizeHeaders } from "./mcp-client-manager/transport-utils.js";
import type { RetryPolicy } from "./retry.js";
import type {
  ProbeMcpServerConfig,
  ProbeMcpServerResult,
} from "./server-probe.js";

export interface ServerDoctorError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ServerDoctorCheck {
  status: "ok" | "error" | "skipped";
  detail: string;
}

export interface ServerDoctorConnection {
  status: "connected" | "error" | "skipped";
  detail: string;
}

export interface ServerDoctorChecks {
  probe: ServerDoctorCheck;
  connection: ServerDoctorCheck;
  initialization: ServerDoctorCheck;
  capabilities: ServerDoctorCheck;
  tools: ServerDoctorCheck;
  resources: ServerDoctorCheck;
  resourceTemplates: ServerDoctorCheck;
  prompts: ServerDoctorCheck;
  /**
   * Skills over MCP (SEP-2640).
   *
   * `skipped` when the extension is not mutually declared — the common case,
   * and not a fault. When it IS active this is the only doctor check that
   * VERIFIES rather than counts: it fetches a sample of skills through the
   * verified read path, so a server whose digests do not match its bytes is
   * reported as broken here rather than discovered later by a host that
   * refuses to load anything.
   */
  skills: ServerDoctorCheck;
}

export interface ServerDoctorResult<TTarget = unknown> {
  target: TTarget;
  generatedAt: string;
  status: "ready" | "oauth_required" | "partial" | "error";
  probe: ProbeMcpServerResult | null;
  connection: ServerDoctorConnection;
  initInfo: unknown | null;
  capabilities: unknown | null;
  tools: unknown[];
  toolsMetadata: Record<string, unknown>;
  resources: unknown[];
  resourceTemplates: unknown[];
  prompts: unknown[];
  skills: unknown[];
  checks: ServerDoctorChecks;
  error: ServerDoctorError | null;
}

export interface ConnectedServerDoctorState {
  initInfo: unknown | null;
  capabilities: unknown | null;
  tools: unknown[];
  toolsMetadata: Record<string, unknown>;
  resources: unknown[];
  resourceTemplates: unknown[];
  prompts: unknown[];
  skills: unknown[];
  checks: Pick<
    ServerDoctorChecks,
    | "initialization"
    | "capabilities"
    | "tools"
    | "resources"
    | "resourceTemplates"
    | "prompts"
    | "skills"
  >;
  errors: ServerDoctorError[];
}

export interface DoctorToolsCollectionResult {
  tools: unknown[];
  toolsMetadata: Record<string, unknown>;
  check: ServerDoctorCheck;
  error?: ServerDoctorError;
}

export interface DoctorResourcesCollectionResult {
  resources: unknown[];
  check: ServerDoctorCheck;
  error?: ServerDoctorError;
}

export interface DoctorPromptsCollectionResult {
  prompts: unknown[];
  check: ServerDoctorCheck;
  error?: ServerDoctorError;
}

export interface DoctorResourceTemplatesCollectionResult {
  resourceTemplates: unknown[];
  check: ServerDoctorCheck;
  error?: ServerDoctorError;
}

export interface DoctorSkillsCollectionResult {
  skills: unknown[];
  check: ServerDoctorCheck;
  /**
   * Absent when skills are simply not served. A verification failure is a
   * finding about the SERVER, so unlike the other collectors this one reports
   * it through the check detail rather than as a doctor-level error: the run
   * succeeded, and what it found is that the skills do not verify.
   */
  error?: ServerDoctorError;
}

interface DoctorProbeCapableConfig {
  url: string;
  accessToken?: string;
  requestInit?: {
    headers?: HeadersInit;
  };
  authProvider?: unknown;
  refreshToken?: string;
  clientCapabilities?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
}

interface BuildConnectedServerDoctorStateInput {
  initInfo: unknown | null;
  capabilities: unknown | null;
  toolsResult: DoctorToolsCollectionResult;
  resourcesResult: DoctorResourcesCollectionResult;
  promptsResult: DoctorPromptsCollectionResult;
  resourceTemplatesResult: DoctorResourceTemplatesCollectionResult;
  skillsResult: DoctorSkillsCollectionResult;
}

export function createServerDoctorResult<TTarget>(
  target: TTarget,
  options: {
    probeDetail?: string;
  } = {}
): ServerDoctorResult<TTarget> {
  return {
    target,
    generatedAt: new Date().toISOString(),
    status: "ready",
    probe: null,
    connection: {
      status: "skipped",
      detail: "Connection step did not run.",
    },
    initInfo: null,
    capabilities: null,
    tools: [],
    toolsMetadata: {},
    resources: [],
    resourceTemplates: [],
    prompts: [],
    skills: [],
    checks: {
      probe: skippedCheck(options.probeDetail ?? "HTTP probe did not run."),
      connection: skippedCheck("Connection step did not run."),
      initialization: skippedCheck("Initialization info was not collected."),
      capabilities: skippedCheck("Capabilities were not collected."),
      tools: skippedCheck("Tools were not collected."),
      resources: skippedCheck("Resources were not collected."),
      resourceTemplates: skippedCheck("Resource templates were not collected."),
      prompts: skippedCheck("Prompts were not collected."),
      skills: skippedCheck("Skills were not collected."),
    },
    error: null,
  };
}

export function applyConnectedServerDoctorState<TTarget>(
  result: ServerDoctorResult<TTarget>,
  collected: ConnectedServerDoctorState
): void {
  result.connection = {
    status: "connected",
    detail: "Connected and initialized successfully.",
  };
  result.checks.connection = okCheck(result.connection.detail);
  result.initInfo = collected.initInfo;
  result.capabilities = collected.capabilities;
  result.tools = collected.tools;
  result.toolsMetadata = collected.toolsMetadata;
  result.resources = collected.resources;
  result.resourceTemplates = collected.resourceTemplates;
  result.prompts = collected.prompts;
  result.skills = collected.skills;
  result.checks.initialization = collected.checks.initialization;
  result.checks.capabilities = collected.checks.capabilities;
  result.checks.tools = collected.checks.tools;
  result.checks.resources = collected.checks.resources;
  result.checks.resourceTemplates = collected.checks.resourceTemplates;
  result.checks.prompts = collected.checks.prompts;
  result.checks.skills = collected.checks.skills;

  if (collected.errors.length > 0) {
    result.error = collected.errors[0] ?? result.error;
  }
}

export function buildConnectedServerDoctorState(
  input: BuildConnectedServerDoctorStateInput
): ConnectedServerDoctorState {
  const errors = [
    input.toolsResult.error,
    input.resourcesResult.error,
    input.promptsResult.error,
    input.resourceTemplatesResult.error,
    input.skillsResult.error,
  ].filter((error): error is ServerDoctorError => Boolean(error));

  return {
    initInfo: input.initInfo,
    capabilities: input.capabilities,
    tools: input.toolsResult.tools,
    toolsMetadata: input.toolsResult.toolsMetadata,
    resources: input.resourcesResult.resources,
    resourceTemplates: input.resourceTemplatesResult.resourceTemplates,
    prompts: input.promptsResult.prompts,
    skills: input.skillsResult.skills,
    checks: {
      initialization: input.initInfo
        ? okCheck("Initialization info captured.")
        : errorCheck(
            "Server connected but did not return initialization info."
          ),
      capabilities: input.capabilities
        ? okCheck("Server capabilities captured.")
        : errorCheck("Server connected but did not advertise capabilities."),
      tools: input.toolsResult.check,
      resources: input.resourcesResult.check,
      resourceTemplates: input.resourceTemplatesResult.check,
      prompts: input.promptsResult.check,
      skills: input.skillsResult.check,
    },
    errors,
  };
}

export function buildDoctorProbeConfig(
  config: DoctorProbeCapableConfig,
  options: {
    timeout: number;
    retryPolicy?: RetryPolicy;
    /**
     * Transport for every probe request. Deployments that must not let a target
     * steer the probe at their own network pass a guarded fetch here — the probe
     * cannot resolve DNS itself without pulling `node:dns` into runtimes that
     * have no such module.
     */
    fetchFn?: typeof fetch;
  }
): ProbeMcpServerConfig {
  const accessToken = resolveProbeAccessToken(config);
  const clientCapabilities = resolveDoctorClientCapabilities(config);

  return {
    url: config.url,
    headers: normalizeHeaders(config.requestInit?.headers),
    ...(accessToken ? { accessToken } : {}),
    ...(clientCapabilities ? { clientCapabilities } : {}),
    timeoutMs: options.timeout,
    retryPolicy: options.retryPolicy,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  };
}

export function normalizeServerDoctorError(error: unknown): ServerDoctorError {
  if (isServerDoctorError(error)) {
    return error;
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown error";
  const lower = message.toLowerCase();

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return { code: "TIMEOUT", message };
  }

  if (
    lower.includes("connect") ||
    lower.includes("connection") ||
    lower.includes("refused") ||
    lower.includes("econn")
  ) {
    return { code: "SERVER_UNREACHABLE", message };
  }

  return { code: "INTERNAL_ERROR", message };
}

export function resolveProbeAccessToken(
  config: DoctorProbeCapableConfig
): string | undefined {
  const explicitToken = config.accessToken?.trim();
  if (explicitToken) {
    return explicitToken;
  }

  const headers = normalizeHeaders(config.requestInit?.headers);
  const authorizationHeader = getExistingAuthorization(headers);
  if (!authorizationHeader) {
    return undefined;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

export function resolveDoctorClientCapabilities(
  config: DoctorProbeCapableConfig
): Record<string, unknown> | undefined {
  return config.clientCapabilities ?? config.capabilities;
}

export function hasConnectionCredentials(
  config: DoctorProbeCapableConfig,
  options: {
    includeAuthProvider?: boolean;
  } = {}
): boolean {
  return Boolean(
    resolveProbeAccessToken(config) ||
      config.refreshToken ||
      (options.includeAuthProvider === false ? undefined : config.authProvider)
  );
}

export function summarizeProbeCheck(
  probe: ProbeMcpServerResult,
  hasCredentials: boolean
): ServerDoctorCheck {
  switch (probe.status) {
    case "ready":
      return okCheck(
        `HTTP initialize probe succeeded via ${
          probe.transport.selected ?? "unknown transport"
        }.`
      );
    case "oauth_required": {
      // The probe accepts a 403 that still carries a Bearer challenge, so the
      // check has to name the status it accepted. Reporting a server that only
      // ever answers 403 as a clean OAuth requirement hides the reason clients
      // keying on the status alone never start OAuth against it.
      const challenge = probe.oauth.nonCompliantChallengeStatus
        ? ` The challenge arrived on HTTP ${probe.oauth.nonCompliantChallengeStatus}; MCP requires 401 Unauthorized here, so clients that decide to authenticate from the status code alone will not start OAuth against this server.`
        : "";
      return hasCredentials
        ? okCheck(
            `Unauthenticated probe requires OAuth; continuing with provided credentials.${challenge}`
          )
        : errorCheck(
            `Server requires OAuth before it can be connected.${challenge}`
          );
    }
    case "reachable":
      return errorCheck(
        "HTTP endpoint was reachable, but the initialize probe did not complete successfully."
      );
    case "error":
      return errorCheck(probe.error ?? "HTTP probe failed.");
    default: {
      const exhaustive: never = probe.status;
      return errorCheck(String(exhaustive));
    }
  }
}

export function deriveDoctorStatus<TTarget>(
  result: ServerDoctorResult<TTarget>
): ServerDoctorResult<TTarget>["status"] {
  if (
    result.probe?.status === "oauth_required" &&
    result.connection.status === "skipped"
  ) {
    return "oauth_required";
  }

  if (result.connection.status === "error") {
    return "error";
  }

  return Object.values(result.checks).some((check) => check.status === "error")
    ? "partial"
    : "ready";
}

export function okCheck(detail: string): ServerDoctorCheck {
  return { status: "ok", detail };
}

export function errorCheck(detail: string): ServerDoctorCheck {
  return { status: "error", detail };
}

export function skippedCheck(detail: string): ServerDoctorCheck {
  return { status: "skipped", detail };
}

export function describeCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"} discovered.`;
}

function isServerDoctorError(error: unknown): error is ServerDoctorError {
  return (
    !!error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  );
}
