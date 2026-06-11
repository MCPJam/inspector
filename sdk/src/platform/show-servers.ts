/**
 * Core logic for the `show_servers` platform operation: resolve a project,
 * inspect its servers via the Platform API's hosted doctor (one call per
 * server), and assemble a stable `ShowServersPayload`. UI-agnostic — the
 * MCP worker renders this payload as an MCP Apps widget, the CLI as text.
 */
import { isPlatformApiError, PlatformApiError } from "./errors.js";
import type {
  PlatformDoctorReport,
  PlatformProject,
  PlatformProjectServer,
} from "./types.js";

export type ServerStatus = "reachable" | "unreachable" | "skipped" | "error";

export type ServerTransportType = "http" | "stdio";

export type ServerInfo = {
  name?: string;
  version?: string;
};

export type ServerPrimitiveListStatus = "loaded" | "skipped" | "error";

export type ServerPrimitiveCollection<TItem> = {
  status: ServerPrimitiveListStatus;
  items: TItem[];
  statusDetail?: string;
};

export type ServerToolInfo = {
  name: string;
  title?: string;
  description?: string;
};

export type ServerResourceInfo = {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

export type ServerPromptArgumentInfo = {
  name: string;
  description?: string;
  required?: boolean;
};

export type ServerPromptInfo = {
  name: string;
  title?: string;
  description?: string;
  arguments?: ServerPromptArgumentInfo[];
};

export type ServerPrimitives = {
  tools: ServerPrimitiveCollection<ServerToolInfo>;
  resources: ServerPrimitiveCollection<ServerResourceInfo>;
  prompts: ServerPrimitiveCollection<ServerPromptInfo>;
};

export type ServerEntry = {
  id: string;
  name: string;
  transportType: ServerTransportType;
  url?: string;
  status: ServerStatus;
  statusDetail?: string;
  serverInfo?: ServerInfo;
  primitives?: ServerPrimitives;
};

export type ProjectInfo = {
  id: string;
  name: string;
};

export type SelectedProjectInfo = ProjectInfo & {
  organizationId: string;
};

export type ShowServersSummary = Record<ServerStatus, number>;

export type ShowServersPayload = {
  project: SelectedProjectInfo;
  servers: ServerEntry[];
  otherProjects: ProjectInfo[];
  summary: ShowServersSummary;
  generatedAt: string;
};

export const SHOW_SERVERS_DOCTOR_CONCURRENCY = 3;
const MAX_PRIMITIVE_DESCRIPTION_LENGTH = 360;

const STDIO_SKIP_REASON =
  "stdio transport is not supported by the hosted MCPJam MCP server.";
const MISSING_URL_SKIP_REASON = "HTTP server is missing a URL.";
const HOSTED_HTTP_SKIP_REASON =
  "Hosted MCPJam MCP only probes HTTPS HTTP servers.";

export type ProjectResolution =
  | {
      ok: true;
      project: PlatformProject;
      sortedProjects: PlatformProject[];
    }
  | {
      ok: false;
      message: string;
    };

export function resolveProject(
  projects: PlatformProject[],
  selector?: string
): ProjectResolution {
  const sortedProjects = sortProjects(projects);
  if (sortedProjects.length === 0) {
    return {
      ok: false,
      message: "No accessible MCPJam projects were found.",
    };
  }

  const trimmedSelector = selector?.trim();
  if (!trimmedSelector) {
    return {
      ok: true,
      project: sortedProjects[0]!,
      sortedProjects,
    };
  }

  const idMatch = sortedProjects.find(
    (project) => project.id === trimmedSelector
  );
  if (idMatch) {
    return {
      ok: true,
      project: idMatch,
      sortedProjects,
    };
  }

  const normalizedSelector = trimmedSelector.toLocaleLowerCase();
  const nameMatches = sortedProjects.filter(
    (project) => project.name.toLocaleLowerCase() === normalizedSelector
  );

  if (nameMatches.length === 1) {
    return {
      ok: true,
      project: nameMatches[0]!,
      sortedProjects,
    };
  }

  if (nameMatches.length > 1) {
    return {
      ok: false,
      message: `Project name "${trimmedSelector}" is ambiguous. Use one of these project IDs: ${formatProjectList(
        nameMatches
      )}.`,
    };
  }

  return {
    ok: false,
    message: `Project "${trimmedSelector}" was not found. Available projects: ${formatProjectList(
      sortedProjects
    )}.`,
  };
}

export type ShowServersDoctorFn = (args: {
  projectId: string;
  serverId: string;
  signal?: AbortSignal;
}) => Promise<PlatformDoctorReport>;

export type BuildShowServersPayloadInput = {
  doctor: ShowServersDoctorFn;
  project: PlatformProject;
  projects: PlatformProject[];
  servers: PlatformProjectServer[];
  generatedAt: string;
  signal?: AbortSignal;
};

export async function buildShowServersPayload({
  doctor,
  project,
  projects,
  servers,
  generatedAt,
  signal,
}: BuildShowServersPayloadInput): Promise<ShowServersPayload> {
  const serverEntries = new Array<ServerEntry>(servers.length);
  const doctorTargets: Array<{ index: number; server: PlatformProjectServer }> =
    [];

  servers.forEach((server, index) => {
    if (server.transportType === "stdio") {
      serverEntries[index] = baseEntry(server, "skipped", STDIO_SKIP_REASON);
      return;
    }

    if (!server.url) {
      serverEntries[index] = baseEntry(
        server,
        "skipped",
        MISSING_URL_SKIP_REASON
      );
      return;
    }

    if (!isSupportedHostedHttpUrl(server.url)) {
      serverEntries[index] = baseEntry(
        server,
        "skipped",
        HOSTED_HTTP_SKIP_REASON
      );
      return;
    }

    doctorTargets.push({ index, server });
  });

  const doctoredEntries = await mapWithConcurrency(
    doctorTargets,
    SHOW_SERVERS_DOCTOR_CONCURRENCY,
    async (target) => {
      try {
        const report = await doctor({
          projectId: project.id,
          serverId: target.server.id,
          signal,
        });
        return entryFromDoctorReport(target.server, report);
      } catch (error) {
        // Caller-initiated cancellation fails the whole operation; it must
        // not masquerade as per-server unreachability.
        if (signal?.aborted) {
          throw error;
        }
        return entryFromDoctorError(target.server, error);
      }
    }
  );

  doctoredEntries.forEach((entry, doctorIndex) => {
    const target = doctorTargets[doctorIndex]!;
    serverEntries[target.index] = entry;
  });

  const completedEntries = serverEntries.filter(
    (entry): entry is ServerEntry => entry != null
  );

  return {
    project: {
      id: project.id,
      name: project.name,
      organizationId: project.organizationId ?? "",
    },
    servers: completedEntries,
    otherProjects: sortProjects(projects)
      .filter((candidate) => candidate.id !== project.id)
      .map(toProjectInfo),
    summary: summarizeServers(completedEntries),
    generatedAt,
  };
}

function entryFromDoctorReport(
  server: PlatformProjectServer,
  report: PlatformDoctorReport
): ServerEntry {
  const serverInfo = coerceServerInfo(
    report.probe?.initialize?.serverInfo ??
      (report.initInfo as { serverInfo?: unknown } | null | undefined)
        ?.serverInfo
  );
  const base = {
    ...baseEntry(server, "unreachable" as const),
    ...(serverInfo ? { serverInfo } : {}),
  };

  if (report.status === "oauth_required") {
    return {
      ...base,
      status: "reachable",
      statusDetail: "OAuth required; endpoint responded to the MCP probe.",
    };
  }

  if (report.connection?.status === "connected") {
    return {
      ...base,
      status: "reachable",
      statusDetail: "MCP initialize succeeded.",
      primitives: {
        tools: primitiveCollection(
          report.tools.map(coerceToolInfo).filter(isPresent),
          report.checks.tools
        ),
        resources: primitiveCollection(
          report.resources.map(coerceResourceInfo).filter(isPresent),
          report.checks.resources
        ),
        prompts: primitiveCollection(
          report.prompts.map(coercePromptInfo).filter(isPresent),
          report.checks.prompts
        ),
      },
    };
  }

  return {
    ...base,
    status: "unreachable",
    statusDetail:
      report.error?.message ??
      report.connection?.detail ??
      `Doctor completed with status "${report.status}" without a successful connection.`,
  };
}

function entryFromDoctorError(
  server: PlatformProjectServer,
  error: unknown
): ServerEntry {
  if (isPlatformApiError(error)) {
    if (error.code === "OAUTH_REQUIRED" || error.details?.oauthRequired === true) {
      return baseEntry(server, "reachable", `OAuth required. ${error.message}`);
    }

    if (error.code === "RATE_LIMITED") {
      const retryHint =
        error.retryAfter !== undefined
          ? ` Retry after ${error.retryAfter}s.`
          : "";
      return baseEntry(
        server,
        "error",
        `RATE_LIMITED: ${error.message}${retryHint}`
      );
    }

    // 502/504 from the API describe the target MCP server; client-side
    // NETWORK_ERROR/TIMEOUT mean we never got an answer about it either way.
    // The status fallback covers gateways that emit 502/504 without a
    // well-formed envelope (the client then synthesizes INTERNAL_ERROR).
    if (
      error.code === "SERVER_UNREACHABLE" ||
      error.code === "TIMEOUT" ||
      error.code === "NETWORK_ERROR" ||
      error.status === 502 ||
      error.status === 504
    ) {
      return baseEntry(server, "unreachable", error.message);
    }

    return baseEntry(server, "error", `${error.code}: ${error.message}`);
  }

  return baseEntry(server, "unreachable", errorMessage(error));
}

function baseEntry(
  server: PlatformProjectServer,
  status: ServerStatus,
  statusDetail?: string
): ServerEntry {
  return {
    id: server.id,
    name: server.name,
    transportType: server.transportType === "stdio" ? "stdio" : "http",
    ...(server.url ? { url: server.url } : {}),
    status,
    ...(statusDetail ? { statusDetail } : {}),
  };
}

function sortProjects(projects: PlatformProject[]): PlatformProject[] {
  return [...projects].sort((left, right) => {
    const updatedDelta = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
    if (updatedDelta !== 0) {
      return updatedDelta;
    }

    const nameDelta = left.name.localeCompare(right.name);
    if (nameDelta !== 0) {
      return nameDelta;
    }

    return left.id.localeCompare(right.id);
  });
}

function formatProjectList(projects: PlatformProject[]): string {
  return projects
    .map((project) => `${project.name} (id: ${project.id})`)
    .join(", ");
}

function toProjectInfo(project: PlatformProject): ProjectInfo {
  return {
    id: project.id,
    name: project.name,
  };
}

type PrimitiveCheck = {
  status: "ok" | "error" | "skipped";
  detail: string;
};

function primitiveCollection<TItem>(
  items: TItem[],
  check: PrimitiveCheck
): ServerPrimitiveCollection<TItem> {
  return {
    status: primitiveStatusFromCheck(check),
    items,
    statusDetail: check.detail,
  };
}

function primitiveStatusFromCheck(
  check: PrimitiveCheck
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

function coerceServerInfo(value: unknown): ServerInfo | undefined {
  const record = objectRecord(value);
  if (!record) {
    return undefined;
  }

  const name = optionalString(record, "name");
  const version = optionalString(record, "version");

  if (!name && !version) {
    return undefined;
  }

  return {
    ...(name ? { name } : {}),
    ...(version ? { version } : {}),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolution failures become NOT_FOUND platform errors so every surface
 * (MCP tool, CLI) renders the same actionable message.
 */
export function projectResolutionError(message: string): PlatformApiError {
  return new PlatformApiError(message, "NOT_FOUND", { status: 0 });
}
