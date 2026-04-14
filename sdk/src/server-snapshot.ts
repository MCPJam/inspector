import {
  listAllPrompts,
  listAllResourceTemplates,
  listAllResources,
  listAllTools,
  withEphemeralClient,
} from "./operations.js";
import type {
  MCPClientManager,
  MCPServerConfig,
  RpcLogger,
} from "./mcp-client-manager/index.js";

export interface ServerSnapshotTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface ServerSnapshotResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface ServerSnapshotResourceTemplate {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface ServerSnapshotPrompt {
  name: string;
  description?: string;
  arguments?: unknown;
}

export interface CollectedServerSnapshot<TTarget = unknown> {
  target: TTarget;
  generatedAt: string;
  initInfo: unknown | null;
  capabilities: unknown | null;
  tools: ServerSnapshotTool[];
  toolsMetadata: Record<string, unknown>;
  resources: ServerSnapshotResource[];
  resourceTemplates: ServerSnapshotResourceTemplate[];
  resourceTemplatesSupported: boolean;
  prompts: ServerSnapshotPrompt[];
  warnings?: string[];
}

export interface RawServerSnapshot<TTarget = unknown> {
  target: TTarget;
  exportedAt: string;
  initInfo: unknown | null;
  capabilities: unknown | null;
  tools: ServerSnapshotTool[];
  toolsMetadata: Record<string, unknown>;
  resources: ServerSnapshotResource[];
  resourceTemplates: ServerSnapshotResourceTemplate[];
  prompts: ServerSnapshotPrompt[];
}

export interface StableServerSnapshot<TTarget = unknown> {
  kind: "server-snapshot";
  schemaVersion: 1;
  target: TTarget;
  initInfo: unknown | null;
  capabilities: unknown | null;
  tools: ServerSnapshotTool[];
  toolsMetadata: Record<string, unknown>;
  resources: ServerSnapshotResource[];
  resourceTemplates: ServerSnapshotResourceTemplate[];
  resourceTemplatesSupported: boolean;
  prompts: ServerSnapshotPrompt[];
}

export interface NormalizedServerSnapshot<TTarget = unknown> {
  target: TTarget;
  initInfo: unknown | null;
  capabilities: unknown | null;
  tools: ServerSnapshotTool[];
  toolsMetadata: Record<string, unknown>;
  resources: ServerSnapshotResource[];
  resourceTemplates: ServerSnapshotResourceTemplate[];
  resourceTemplatesSupported: boolean | null;
  prompts: ServerSnapshotPrompt[];
}

export interface CollectServerSnapshotInput<TTarget = unknown> {
  config: MCPServerConfig;
  target: TTarget;
  timeout: number;
  rpcLogger?: RpcLogger;
  clientName?: string;
  serverId?: string;
}

type WithSnapshotManager = <T>(
  config: MCPServerConfig,
  fn: (manager: MCPClientManager, serverId: string) => Promise<T>,
  options?: {
    timeout?: number;
    rpcLogger?: RpcLogger;
    clientName?: string;
    serverId?: string;
  }
) => Promise<T>;

export interface ServerSnapshotDependencies {
  withManager?: WithSnapshotManager;
  now?: () => Date;
}

export class ServerSnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerSnapshotFormatError";
  }
}

export async function collectServerSnapshot<TTarget = unknown>(
  input: CollectServerSnapshotInput<TTarget>,
  dependencies: ServerSnapshotDependencies = {}
): Promise<CollectedServerSnapshot<TTarget>> {
  const withManager =
    dependencies.withManager ??
    ((config, fn, options) =>
      withEphemeralClient(config, fn, {
        timeout: options?.timeout,
        rpcLogger: options?.rpcLogger,
        clientName: options?.clientName ?? "mcpjam-sdk",
        serverId: options?.serverId ?? "__snapshot__",
      }));

  return withManager(
    input.config,
    (manager, serverId) =>
      collectConnectedServerSnapshot(manager, serverId, input.target, {
        now: dependencies.now,
      }),
    {
      timeout: input.timeout,
      rpcLogger: input.rpcLogger,
      clientName: input.clientName,
      serverId: input.serverId,
    }
  );
}

export async function collectConnectedServerSnapshot<TTarget = unknown>(
  manager: MCPClientManager,
  serverId: string,
  target: TTarget,
  dependencies: Pick<ServerSnapshotDependencies, "now"> = {}
): Promise<CollectedServerSnapshot<TTarget>> {
  const now = dependencies.now ?? (() => new Date());
  const [toolsResult, resourcesResult, resourceTemplatesResult, promptsResult] =
    await Promise.all([
      listAllTools(manager, { serverId }),
      listAllResources(manager, { serverId }),
      listAllResourceTemplates(manager, { serverId }),
      listAllPrompts(manager, { serverId }),
    ]);

  return {
    target,
    generatedAt: now().toISOString(),
    initInfo: manager.getInitializationInfo(serverId) ?? null,
    capabilities: manager.getServerCapabilities(serverId) ?? null,
    tools: toolsResult.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined
        ? {}
        : { description: tool.description }),
      ...(tool.inputSchema === undefined
        ? {}
        : { inputSchema: tool.inputSchema }),
      ...(tool.outputSchema === undefined
        ? {}
        : { outputSchema: tool.outputSchema }),
    })),
    toolsMetadata: toolsResult.toolsMetadata,
    resources: resourcesResult.resources.map((resource) => ({
      uri: resource.uri,
      ...(resource.name === undefined ? {} : { name: resource.name }),
      ...(resource.description === undefined
        ? {}
        : { description: resource.description }),
      ...(resource.mimeType === undefined
        ? {}
        : { mimeType: resource.mimeType }),
    })),
    resourceTemplates: resourceTemplatesResult.resourceTemplates.map(
      (template) => ({
        uriTemplate: template.uriTemplate,
        ...(template.name === undefined ? {} : { name: template.name }),
        ...(template.description === undefined
          ? {}
          : { description: template.description }),
        ...(template.mimeType === undefined
          ? {}
          : { mimeType: template.mimeType }),
      })
    ),
    resourceTemplatesSupported: !resourceTemplatesResult.unsupported,
    prompts: promptsResult.prompts.map((prompt) => ({
      name: prompt.name,
      ...(prompt.description === undefined
        ? {}
        : { description: prompt.description }),
      ...(prompt.arguments === undefined
        ? {}
        : { arguments: prompt.arguments }),
    })),
  };
}

export function serializeServerSnapshot<TTarget = unknown>(
  snapshot: CollectedServerSnapshot<TTarget>,
  options: { mode?: "raw" | "stable"; now?: () => Date } = {}
): RawServerSnapshot<TTarget> | StableServerSnapshot<TTarget> {
  if (options.mode === "stable") {
    const normalized = normalizeServerSnapshot<TTarget>(snapshot);
    return {
      kind: "server-snapshot",
      schemaVersion: 1,
      target: normalized.target,
      initInfo: normalized.initInfo,
      capabilities: normalized.capabilities,
      tools: normalized.tools,
      toolsMetadata: normalized.toolsMetadata,
      resources: normalized.resources,
      resourceTemplates: normalized.resourceTemplates,
      resourceTemplatesSupported:
        normalized.resourceTemplatesSupported !== false,
      prompts: normalized.prompts,
    };
  }

  const now = options.now ?? (() => new Date());

  return {
    target: snapshot.target,
    exportedAt: snapshot.generatedAt ?? now().toISOString(),
    initInfo: snapshot.initInfo ?? null,
    capabilities: snapshot.capabilities ?? null,
    tools: snapshot.tools ?? [],
    toolsMetadata: snapshot.toolsMetadata ?? {},
    resources: snapshot.resources ?? [],
    resourceTemplates: snapshot.resourceTemplates ?? [],
    prompts: snapshot.prompts ?? [],
  };
}

export function serializeStableServerSnapshot<TTarget = unknown>(
  snapshot: CollectedServerSnapshot<TTarget>
): StableServerSnapshot<TTarget> {
  return serializeServerSnapshot(snapshot, {
    mode: "stable",
  }) as StableServerSnapshot<TTarget>;
}

export function normalizeServerSnapshot<TTarget = unknown>(
  snapshot: unknown
): NormalizedServerSnapshot<TTarget> {
  const record = asRecord(snapshot, "Server snapshot must be an object.");
  validateSnapshotMetadata(record);

  const normalizedTools = readArray(record.tools, "tools").map((tool) =>
    normalizeTool(asRecord(tool, "Each tool snapshot entry must be an object."))
  );
  const normalizedResources = readArray(record.resources, "resources").map(
    (resource) =>
      normalizeResource(
        asRecord(resource, "Each resource snapshot entry must be an object.")
      )
  );
  const normalizedResourceTemplates = readArray(
    record.resourceTemplates,
    "resourceTemplates"
  ).map((template) =>
    normalizeResourceTemplate(
      asRecord(
        template,
        "Each resource template snapshot entry must be an object."
      )
    )
  );
  const normalizedPrompts = readArray(record.prompts, "prompts").map((prompt) =>
    normalizePrompt(
      asRecord(prompt, "Each prompt snapshot entry must be an object.")
    )
  );

  return {
    target: sortKeysDeep(record.target ?? null) as TTarget,
    initInfo: sortKeysDeep(record.initInfo ?? null),
    capabilities: sortKeysDeep(record.capabilities ?? null),
    tools: normalizedTools.sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
    toolsMetadata: sortRecord(
      sortKeysDeep(asLooseRecord(record.toolsMetadata))
    ),
    resources: normalizedResources.sort((left, right) =>
      left.uri.localeCompare(right.uri)
    ),
    resourceTemplates: normalizedResourceTemplates.sort((left, right) =>
      left.uriTemplate.localeCompare(right.uriTemplate)
    ),
    resourceTemplatesSupported:
      readOptionalBoolean(record.resourceTemplatesSupported) ??
      (normalizedResourceTemplates.length > 0 ? true : null),
    prompts: normalizedPrompts.sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
  };
}

function normalizeTool(record: Record<string, unknown>): ServerSnapshotTool {
  const name = readString(
    record.name,
    "Tool snapshots must include a string name."
  );
  return {
    name,
    ...(typeof record.description === "string"
      ? { description: record.description }
      : {}),
    ...(record.inputSchema === undefined
      ? {}
      : { inputSchema: sortKeysDeep(record.inputSchema) }),
    ...(record.outputSchema === undefined
      ? {}
      : { outputSchema: sortKeysDeep(record.outputSchema) }),
  };
}

function normalizeResource(
  record: Record<string, unknown>
): ServerSnapshotResource {
  const uri = readString(
    record.uri,
    "Resource snapshots must include a string uri."
  );
  return {
    uri,
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.description === "string"
      ? { description: record.description }
      : {}),
    ...(typeof record.mimeType === "string"
      ? { mimeType: record.mimeType }
      : {}),
  };
}

function normalizeResourceTemplate(
  record: Record<string, unknown>
): ServerSnapshotResourceTemplate {
  const uriTemplate = readString(
    record.uriTemplate,
    "Resource template snapshots must include a string uriTemplate."
  );
  return {
    uriTemplate,
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.description === "string"
      ? { description: record.description }
      : {}),
    ...(typeof record.mimeType === "string"
      ? { mimeType: record.mimeType }
      : {}),
  };
}

function normalizePrompt(
  record: Record<string, unknown>
): ServerSnapshotPrompt {
  const name = readString(
    record.name,
    "Prompt snapshots must include a string name."
  );
  return {
    name,
    ...(typeof record.description === "string"
      ? { description: record.description }
      : {}),
    ...(record.arguments === undefined
      ? {}
      : { arguments: normalizePromptArguments(record.arguments) }),
  };
}

function validateSnapshotMetadata(record: Record<string, unknown>): void {
  if (record.kind !== undefined && record.kind !== "server-snapshot") {
    throw new ServerSnapshotFormatError(
      `Unsupported server snapshot kind "${String(record.kind)}".`
    );
  }

  if (record.schemaVersion !== undefined && record.schemaVersion !== 1) {
    throw new ServerSnapshotFormatError(
      `Unsupported server snapshot schemaVersion "${String(record.schemaVersion)}".`
    );
  }
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServerSnapshotFormatError(message);
  }
  return value as Record<string, unknown>;
}

function asLooseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readArray(value: unknown, label: string): unknown[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new ServerSnapshotFormatError(
      `Expected "${label}" to be an array when present.`
    );
  }

  return value;
}

function readString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ServerSnapshotFormatError(message);
  }
  return value;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new ServerSnapshotFormatError(
      "Expected resourceTemplatesSupported to be a boolean when present."
    );
  }

  return value;
}

function sortKeysDeep<T>(value: T, parentKey?: string): T {
  if (Array.isArray(value)) {
    const normalizedEntries = value.map((entry) => sortKeysDeep(entry)) as T[];

    if (parentKey === "required") {
      return [...normalizedEntries].sort(compareStableValues) as T;
    }

    if (parentKey === "enum" || parentKey === "type") {
      return [...normalizedEntries].sort(compareStableValues) as T;
    }

    return normalizedEntries as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, sortKeysDeep(record[key], key)])
  ) as T;
}

function sortRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  );
}

function normalizePromptArguments(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return sortKeysDeep(value);
  }

  const normalizedArguments = value.map((entry) => sortKeysDeep(entry));
  if (
    normalizedArguments.every(
      (entry) => isRecord(entry) && typeof entry.name === "string"
    )
  ) {
    return normalizedArguments.sort((left, right) =>
      String((left as { name: string }).name).localeCompare(
        String((right as { name: string }).name)
      )
    );
  }

  return normalizedArguments;
}

function compareStableValues(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
