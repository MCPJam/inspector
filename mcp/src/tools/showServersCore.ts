import {
  probeMcpServer,
  runHttpServerDoctor,
  type HttpServerConfig,
  type ProbeMcpServerConfig,
  type ProbeMcpServerResult,
} from "@mcpjam/sdk/worker";
import type {
  ServerPrimitiveCollection,
  ServerPrimitiveListStatus,
  ServerEntry,
  ServerInfo,
  ServerPromptArgumentInfo,
  ServerPromptInfo,
  ServerResourceInfo,
  ServerTransportType,
  ServerToolInfo,
  ShowServersPayload,
  ShowServersSummary,
  WorkspaceInfo,
} from "../shared/show-servers.js";

export const SHOW_SERVERS_PROBE_TIMEOUT_MS = 7_000;
export const SHOW_SERVERS_PROBE_CONCURRENCY = 5;
const MAX_PRIMITIVE_DESCRIPTION_LENGTH = 360;

const STDIO_SKIP_REASON =
  "stdio transport is not supported by the hosted MCPJam MCP server.";
const MISSING_URL_SKIP_REASON = "HTTP server is missing a URL.";
const HOSTED_HTTP_SKIP_REASON =
  "Hosted MCPJam MCP only probes HTTPS HTTP servers.";

export type RemoteWorkspace = {
  _id: string;
  organizationId: string;
  name: string;
  updatedAt?: number;
};

export type RemoteServer = {
  _id: string;
  name: string;
  transportType: ServerTransportType;
  url?: string;
};

export type BatchAuthorizeSuccess = {
  ok: true;
  oauthAccessToken?: string | null;
  serverConfig: {
    transportType: ServerTransportType;
    url?: string;
    headers?: Record<string, string>;
    useOAuth?: boolean;
  };
};

export type BatchAuthorizeFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type BatchAuthorizeResult =
  | BatchAuthorizeSuccess
  | BatchAuthorizeFailure;

export type BatchAuthorizeResponse = {
  results: Record<string, BatchAuthorizeResult>;
};

export type AuthorizeBatchResult =
  | { ok: true; body: BatchAuthorizeResponse }
  | { ok: false; error: { code: string; message: string } };

export type AuthorizeBatchInput = {
  bearerToken: string;
  convexHttpUrl: string;
  workspaceId: string;
  serverIds: string[];
  fetchFn?: typeof fetch;
};

export type WorkspaceResolution =
  | {
      ok: true;
      workspace: RemoteWorkspace;
      sortedWorkspaces: RemoteWorkspace[];
    }
  | {
      ok: false;
      message: string;
    };

export type BuildShowServersPayloadInput = {
  bearerToken: string;
  convexHttpUrl?: string;
  workspace: RemoteWorkspace;
  workspaces: RemoteWorkspace[];
  servers: RemoteServer[];
  generatedAt: string;
  authorizeBatch?: (
    input: AuthorizeBatchInput
  ) => Promise<AuthorizeBatchResult>;
  probe?: (config: ProbeMcpServerConfig) => Promise<ProbeMcpServerResult>;
  inspect?: (config: ProbeMcpServerConfig) => Promise<InspectMcpServerResult>;
};

type ProbeTarget = {
  index: number;
  server: RemoteServer;
};

type PrimitiveInspectionCheck = {
  status: "ok" | "error" | "skipped";
  detail: string;
};

export type InspectMcpServerResult = {
  probe: ProbeMcpServerResult;
  tools: unknown[];
  resources: unknown[];
  prompts: unknown[];
  checks: {
    tools: PrimitiveInspectionCheck;
    resources: PrimitiveInspectionCheck;
    prompts: PrimitiveInspectionCheck;
  };
};

export function resolveWorkspace(
  workspaces: RemoteWorkspace[],
  selector?: string
): WorkspaceResolution {
  const sortedWorkspaces = sortWorkspaces(workspaces);
  if (sortedWorkspaces.length === 0) {
    return {
      ok: false,
      message: "No accessible MCPJam workspaces were found.",
    };
  }

  const trimmedSelector = selector?.trim();
  if (!trimmedSelector) {
    return {
      ok: true,
      workspace: sortedWorkspaces[0]!,
      sortedWorkspaces,
    };
  }

  const idMatch = sortedWorkspaces.find(
    (workspace) => workspace._id === trimmedSelector
  );
  if (idMatch) {
    return {
      ok: true,
      workspace: idMatch,
      sortedWorkspaces,
    };
  }

  const normalizedSelector = trimmedSelector.toLocaleLowerCase();
  const nameMatches = sortedWorkspaces.filter(
    (workspace) => workspace.name.toLocaleLowerCase() === normalizedSelector
  );

  if (nameMatches.length === 1) {
    return {
      ok: true,
      workspace: nameMatches[0]!,
      sortedWorkspaces,
    };
  }

  if (nameMatches.length > 1) {
    return {
      ok: false,
      message: `Workspace name "${trimmedSelector}" is ambiguous. Use one of these workspace IDs: ${formatWorkspaceList(
        nameMatches
      )}.`,
    };
  }

  return {
    ok: false,
    message: `Workspace "${trimmedSelector}" was not found. Available workspaces: ${formatWorkspaceList(
      sortedWorkspaces
    )}.`,
  };
}

export async function buildShowServersPayload({
  bearerToken,
  convexHttpUrl,
  workspace,
  workspaces,
  servers,
  generatedAt,
  authorizeBatch = authorizeServersForShowServers,
  probe = probeMcpServer,
  inspect,
}: BuildShowServersPayloadInput): Promise<ShowServersPayload> {
  const serverEntries = new Array<ServerEntry>(servers.length);
  const probeTargets: ProbeTarget[] = [];
  const inspectWithDefault =
    inspect ?? (probe === probeMcpServer ? inspectMcpServer : undefined);

  servers.forEach((server, index) => {
    if (server.transportType === "stdio") {
      serverEntries[index] = skippedServerEntry(server, STDIO_SKIP_REASON);
      return;
    }

    if (!server.url) {
      serverEntries[index] = skippedServerEntry(
        server,
        MISSING_URL_SKIP_REASON
      );
      return;
    }

    if (!isSupportedHostedHttpUrl(server.url)) {
      serverEntries[index] = skippedServerEntry(
        server,
        HOSTED_HTTP_SKIP_REASON
      );
      return;
    }

    probeTargets.push({ index, server });
  });

  if (probeTargets.length > 0) {
    if (!convexHttpUrl) {
      for (const target of probeTargets) {
        serverEntries[target.index] = errorServerEntry(
          target.server,
          "Server misconfigured: CONVEX_HTTP_URL is not set."
        );
      }
    } else {
      const authorization = await authorizeBatch({
        bearerToken,
        convexHttpUrl,
        workspaceId: workspace._id,
        serverIds: probeTargets.map((target) => target.server._id),
      });

      if (!authorization.ok) {
        for (const target of probeTargets) {
          serverEntries[target.index] = errorServerEntry(
            target.server,
            authorization.error.message
          );
        }
      } else {
        const probedEntries = await mapWithConcurrency(
          probeTargets,
          SHOW_SERVERS_PROBE_CONCURRENCY,
          (target) =>
            probeServerEntry({
              authorizationResult:
                authorization.body.results[target.server._id],
              inspect: inspectWithDefault,
              probe,
              server: target.server,
            })
        );

        probedEntries.forEach((entry, probeIndex) => {
          const target = probeTargets[probeIndex]!;
          serverEntries[target.index] = entry;
        });
      }
    }
  }

  const completedEntries = serverEntries.filter(
    (entry): entry is ServerEntry => entry != null
  );

  return {
    workspace: {
      id: workspace._id,
      name: workspace.name,
      organizationId: workspace.organizationId,
    },
    servers: completedEntries,
    otherWorkspaces: sortWorkspaces(workspaces)
      .filter((candidate) => candidate._id !== workspace._id)
      .map(toWorkspaceInfo),
    summary: summarizeServers(completedEntries),
    generatedAt,
  };
}

export async function authorizeServersForShowServers({
  bearerToken,
  convexHttpUrl,
  workspaceId,
  serverIds,
  fetchFn = fetch,
}: AuthorizeBatchInput): Promise<AuthorizeBatchResult> {
  let response: Response;

  try {
    response = await fetchFn(
      `${convexHttpUrl.replace(/\/+$/, "")}/web/authorize-batch`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({
          workspaceId,
          serverIds,
        }),
      }
    );
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "SERVER_UNREACHABLE",
        message: `Failed to reach authorization service: ${parseErrorMessage(
          error
        )}`,
      },
    };
  }

  let body:
    | BatchAuthorizeResponse
    | { code?: string; message?: string }
    | null = null;
  try {
    body = (await response.json()) as
      | BatchAuthorizeResponse
      | { code?: string; message?: string };
  } catch {
    // Fall through to a synthetic error below.
  }

  if (!response.ok) {
    const failureBody = body && !("results" in body) ? body : null;
    return {
      ok: false,
      error: {
        code:
          typeof failureBody?.code === "string"
            ? failureBody.code
            : "INTERNAL_ERROR",
        message:
          typeof failureBody?.message === "string"
            ? failureBody.message
            : `Authorization failed (${response.status}).`,
      },
    };
  }

  if (!body || !("results" in body) || typeof body.results !== "object") {
    return {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Authorization response is missing batch results.",
      },
    };
  }

  return { ok: true, body };
}

function sortWorkspaces(workspaces: RemoteWorkspace[]): RemoteWorkspace[] {
  return [...workspaces].sort((left, right) => {
    const updatedDelta = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
    if (updatedDelta !== 0) {
      return updatedDelta;
    }

    const nameDelta = left.name.localeCompare(right.name);
    if (nameDelta !== 0) {
      return nameDelta;
    }

    return left._id.localeCompare(right._id);
  });
}

function formatWorkspaceList(workspaces: RemoteWorkspace[]): string {
  return workspaces
    .map((workspace) => `${workspace.name} (id: ${workspace._id})`)
    .join(", ");
}

function toWorkspaceInfo(workspace: RemoteWorkspace): WorkspaceInfo {
  return {
    id: workspace._id,
    name: workspace.name,
  };
}

function skippedServerEntry(server: RemoteServer, detail: string): ServerEntry {
  return {
    id: server._id,
    name: server.name,
    transportType: server.transportType,
    ...(server.url ? { url: server.url } : {}),
    status: "skipped",
    statusDetail: detail,
  };
}

function errorServerEntry(server: RemoteServer, detail: string): ServerEntry {
  return {
    id: server._id,
    name: server.name,
    transportType: server.transportType,
    ...(server.url ? { url: server.url } : {}),
    status: "error",
    statusDetail: detail,
  };
}

async function probeServerEntry({
  authorizationResult,
  inspect,
  probe,
  server,
}: {
  authorizationResult: BatchAuthorizeResult | undefined;
  inspect?: (config: ProbeMcpServerConfig) => Promise<InspectMcpServerResult>;
  probe: (config: ProbeMcpServerConfig) => Promise<ProbeMcpServerResult>;
  server: RemoteServer;
}): Promise<ServerEntry> {
  if (!authorizationResult) {
    return errorServerEntry(
      server,
      `Authorization response is missing result for server "${server._id}".`
    );
  }

  if (!authorizationResult.ok) {
    return errorServerEntry(
      server,
      `${authorizationResult.code}: ${authorizationResult.message}`
    );
  }

  if (authorizationResult.serverConfig.transportType !== "http") {
    return errorServerEntry(server, "Authorized server is not an HTTP server.");
  }

  const authorizedUrl = authorizationResult.serverConfig.url;
  if (!authorizedUrl || !isSupportedHostedHttpUrl(authorizedUrl)) {
    return errorServerEntry(
      server,
      "Authorized server URL is missing or is not HTTPS."
    );
  }

  try {
    const probeConfig = {
      url: authorizedUrl,
      headers: authorizationResult.serverConfig.headers,
      accessToken: authorizationResult.oauthAccessToken ?? undefined,
      timeoutMs: SHOW_SERVERS_PROBE_TIMEOUT_MS,
      clientName: "mcpjam-show-servers",
      clientVersion: "1.0.0",
      retryPolicy: {
        retries: 0,
        retryDelayMs: 0,
      },
    } satisfies ProbeMcpServerConfig;

    if (inspect) {
      const result = await inspect(probeConfig);
      return entryFromInspectionResult(server, result);
    }

    const result = await probe(probeConfig);

    return entryFromProbeResult(server, result);
  } catch (error) {
    return {
      id: server._id,
      name: server.name,
      transportType: server.transportType,
      ...(server.url ? { url: server.url } : {}),
      status: "unreachable",
      statusDetail: parseErrorMessage(error),
    };
  }
}

function entryFromProbeResult(
  server: RemoteServer,
  result: ProbeMcpServerResult
): ServerEntry {
  const serverInfo = coerceServerInfo(result.initialize?.serverInfo);
  const baseEntry = {
    id: server._id,
    name: server.name,
    transportType: server.transportType,
    ...(server.url ? { url: server.url } : {}),
    ...(serverInfo ? { serverInfo } : {}),
  };

  if (result.status === "ready") {
    return {
      ...baseEntry,
      status: "reachable",
      statusDetail: "MCP initialize succeeded.",
    };
  }

  if (result.status === "oauth_required") {
    return {
      ...baseEntry,
      status: "reachable",
      statusDetail: "OAuth required; endpoint responded to the MCP probe.",
    };
  }

  return {
    ...baseEntry,
    status: "unreachable",
    statusDetail: getProbeStatusDetail(result),
  };
}

function entryFromInspectionResult(
  server: RemoteServer,
  result: InspectMcpServerResult
): ServerEntry {
  const entry = entryFromProbeResult(server, result.probe);

  if (entry.status !== "reachable") {
    return entry;
  }

  return {
    ...entry,
    primitives: {
      tools: primitiveCollection(
        result.tools.map(coerceToolInfo).filter(isPresent),
        result.checks.tools
      ),
      resources: primitiveCollection(
        result.resources.map(coerceResourceInfo).filter(isPresent),
        result.checks.resources
      ),
      prompts: primitiveCollection(
        result.prompts.map(coercePromptInfo).filter(isPresent),
        result.checks.prompts
      ),
    },
  };
}

export async function inspectMcpServer(
  config: ProbeMcpServerConfig
): Promise<InspectMcpServerResult> {
  const doctorConfig = {
    url: config.url,
    ...(config.accessToken ? { accessToken: config.accessToken } : {}),
    ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
    ...(config.clientVersion ? { version: config.clientVersion } : {}),
    ...(config.clientCapabilities
      ? {
          clientCapabilities:
            config.clientCapabilities as HttpServerConfig["clientCapabilities"],
        }
      : {}),
  } satisfies HttpServerConfig;

  const result = await runHttpServerDoctor({
    config: doctorConfig,
    target: config.url,
    timeout: config.timeoutMs ?? SHOW_SERVERS_PROBE_TIMEOUT_MS,
    retryPolicy: config.retryPolicy,
  });

  return {
    probe:
      result.probe ??
      inspectionErrorProbe(
        config,
        result.error?.message ?? result.connection.detail
      ),
    tools: result.tools,
    resources: result.resources,
    prompts: result.prompts,
    checks: {
      tools: result.checks.tools,
      resources: result.checks.resources,
      prompts: result.checks.prompts,
    },
  };
}

function primitiveCollection<TItem>(
  items: TItem[],
  check: PrimitiveInspectionCheck
): ServerPrimitiveCollection<TItem> {
  return {
    status: primitiveStatusFromCheck(check),
    items,
    statusDetail: check.detail,
  };
}

function primitiveStatusFromCheck(
  check: PrimitiveInspectionCheck
): ServerPrimitiveListStatus {
  if (check.status === "error") {
    return "error";
  }

  if (check.status === "skipped") {
    return "skipped";
  }

  return "loaded";
}

function coerceToolInfo(value: unknown): ServerToolInfo | undefined {
  const record = objectRecord(value);
  const name = record ? optionalString(record, "name") : undefined;
  if (!record || !name) {
    return undefined;
  }

  const title = optionalString(record, "title");
  const description = optionalDescription(record);

  return {
    name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

function coerceResourceInfo(value: unknown): ServerResourceInfo | undefined {
  const record = objectRecord(value);
  const uri = record ? optionalString(record, "uri") : undefined;
  if (!record || !uri) {
    return undefined;
  }

  const name = optionalString(record, "name");
  const title = optionalString(record, "title");
  const description = optionalDescription(record);
  const mimeType = optionalString(record, "mimeType");

  return {
    uri,
    ...(name ? { name } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(mimeType ? { mimeType } : {}),
  };
}

function coercePromptInfo(value: unknown): ServerPromptInfo | undefined {
  const record = objectRecord(value);
  const name = record ? optionalString(record, "name") : undefined;
  if (!record || !name) {
    return undefined;
  }

  const promptArguments = Array.isArray(record.arguments)
    ? record.arguments.map(coercePromptArgumentInfo).filter(isPresent)
    : undefined;
  const title = optionalString(record, "title");
  const description = optionalDescription(record);

  return {
    name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(promptArguments && promptArguments.length > 0
      ? { arguments: promptArguments }
      : {}),
  };
}

function coercePromptArgumentInfo(
  value: unknown
): ServerPromptArgumentInfo | undefined {
  const record = objectRecord(value);
  const name = record ? optionalString(record, "name") : undefined;
  if (!record || !name) {
    return undefined;
  }

  const description = optionalDescription(record);

  return {
    name,
    ...(description ? { description } : {}),
    ...(typeof record.required === "boolean"
      ? { required: record.required }
      : {}),
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalDescription(
  record: Record<string, unknown>
): string | undefined {
  const description = optionalString(record, "description");
  return description
    ? truncateText(description, MAX_PRIMITIVE_DESCRIPTION_LENGTH)
    : undefined;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function isPresent<TValue>(value: TValue | undefined): value is TValue {
  return value !== undefined;
}

function inspectionErrorProbe(
  config: ProbeMcpServerConfig,
  message: string
): ProbeMcpServerResult {
  return {
    url: config.url,
    protocolVersion: config.protocolVersion ?? "2025-11-25",
    status: "error",
    transport: {
      attempts: [],
    },
    oauth: {
      required: false,
      optional: false,
      registrationStrategies: [],
    },
    error: message,
  };
}

function getProbeStatusDetail(result: ProbeMcpServerResult): string {
  if (result.status === "oauth_required") {
    return "Server requires OAuth or authorization that was not satisfied.";
  }

  if (result.error) {
    return result.error;
  }

  return `Probe completed with status "${result.status}" without a successful MCP initialize.`;
}

function coerceServerInfo(value: unknown): ServerInfo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const name =
    typeof record.name === "string" && record.name.length > 0
      ? record.name
      : undefined;
  const version =
    typeof record.version === "string" && record.version.length > 0
      ? record.version
      : undefined;

  if (!name && !version) {
    return undefined;
  }

  return {
    ...(name ? { name } : {}),
    ...(version ? { version } : {}),
  };
}

function summarizeServers(servers: ServerEntry[]): ShowServersSummary {
  const summary: ShowServersSummary = {
    reachable: 0,
    unreachable: 0,
    skipped: 0,
    error: 0,
  };

  for (const server of servers) {
    summary[server.status] += 1;
  }

  return summary;
}

function isSupportedHostedHttpUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

async function mapWithConcurrency<TInput, TOutput>(
  inputs: TInput[],
  concurrency: number,
  mapper: (input: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
  const results = new Array<TOutput>(inputs.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < inputs.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(inputs[currentIndex]!, currentIndex);
    }
  }

  const workerCount = Math.min(Math.max(concurrency, 1), inputs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

function parseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
