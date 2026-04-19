import { probeMcpServer } from "./server-probe.js";
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
  RetryPolicy,
  RpcLogger,
} from "./mcp-client-manager/index.js";
import {
  applyConnectedServerDoctorState,
  buildConnectedServerDoctorState,
  buildDoctorProbeConfig,
  createServerDoctorResult,
  deriveDoctorStatus,
  describeCount,
  errorCheck,
  hasConnectionCredentials,
  normalizeServerDoctorError,
  okCheck,
  skippedCheck,
  summarizeProbeCheck,
} from "./server-doctor-core.js";
import type {
  ConnectedServerDoctorState,
  DoctorPromptsCollectionResult,
  DoctorResourceTemplatesCollectionResult,
  DoctorResourcesCollectionResult,
  DoctorToolsCollectionResult,
  ServerDoctorResult,
} from "./server-doctor-core.js";

export { normalizeServerDoctorError } from "./server-doctor-core.js";
export type {
  ConnectedServerDoctorState,
  ServerDoctorCheck,
  ServerDoctorChecks,
  ServerDoctorConnection,
  ServerDoctorError,
  ServerDoctorResult,
} from "./server-doctor-core.js";

export interface RunServerDoctorInput<TTarget = unknown> {
  config: MCPServerConfig;
  target: TTarget;
  timeout: number;
  rpcLogger?: RpcLogger;
  retryPolicy?: RetryPolicy;
}

type WithConnectedManager = <T>(
  config: MCPServerConfig,
  fn: (manager: MCPClientManager, serverId: string) => Promise<T>,
  options?: {
    timeout?: number;
    rpcLogger?: RpcLogger;
    retryPolicy?: RetryPolicy;
  }
) => Promise<T>;

export interface ServerDoctorDependencies {
  probeServer?: typeof probeMcpServer;
  withManager?: WithConnectedManager;
}

export async function runServerDoctor<TTarget = unknown>(
  input: RunServerDoctorInput<TTarget>,
  dependencies: ServerDoctorDependencies = {}
): Promise<ServerDoctorResult<TTarget>> {
  const probeServer = dependencies.probeServer ?? probeMcpServer;
  const withManager =
    dependencies.withManager ??
    ((config, fn, options) =>
      withEphemeralClient(config, fn, {
        timeout: options?.timeout,
        rpcLogger: options?.rpcLogger,
        retryPolicy: options?.retryPolicy,
        serverId: "__cli__",
        clientName: "mcpjam",
      }));
  const result = createServerDoctorResult(input.target, {
    probeDetail:
      "url" in input.config
        ? "HTTP probe did not run."
        : "HTTP probe not applicable for stdio targets.",
  });

  if ("url" in input.config) {
    const probeUrl = input.config.url;
    if (!probeUrl) {
      throw new Error("HTTP doctor flow requires a server URL.");
    }

    try {
      result.probe = await probeServer(
        buildDoctorProbeConfig(input.config, {
          timeout: input.timeout,
          retryPolicy: input.retryPolicy,
        })
      );
      result.checks.probe = summarizeProbeCheck(
        result.probe,
        hasConnectionCredentials(input.config, {
          includeAuthProvider: false,
        })
      );
    } catch (error) {
      const structured = normalizeServerDoctorError(error);
      result.checks.probe = errorCheck(
        `HTTP probe failed: ${structured.message}`
      );
      result.error = structured;
    }

    if (
      result.probe?.status === "oauth_required" &&
      !hasConnectionCredentials(input.config)
    ) {
      result.status = "oauth_required";
      result.connection = {
        status: "skipped",
        detail: "Server requires OAuth before a connection can be established.",
      };
      result.checks.connection = skippedCheck(result.connection.detail);
      result.error = {
        code: "OAUTH_REQUIRED",
        message:
          "Server requires OAuth before it can be connected. Run an OAuth login flow first.",
        details: {
          registrationStrategies: result.probe.oauth.registrationStrategies,
          authorizationServerMetadataUrl:
            result.probe.oauth.authorizationServerMetadataUrl,
          resourceMetadataUrl: result.probe.oauth.resourceMetadataUrl,
        },
      };
      return result;
    }
  }

  try {
    const collected = await withManager(
      input.config,
      (manager, serverId) =>
        collectConnectedServerDoctorState(manager, serverId),
      {
        timeout: input.timeout,
        rpcLogger: input.rpcLogger,
        retryPolicy: input.retryPolicy,
      }
    );

    applyConnectedServerDoctorState(result, collected);
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    result.connection = {
      status: "error",
      detail: structured.message,
    };
    result.checks.connection = errorCheck(structured.message);
    result.error = structured;
  }

  result.status = deriveDoctorStatus(result);
  if (result.status === "ready") {
    result.error = null;
  }

  return result;
}

export async function collectConnectedServerDoctorState(
  manager: MCPClientManager,
  serverId: string
): Promise<ConnectedServerDoctorState> {
  const initInfo = manager.getInitializationInfo(serverId) ?? null;
  const capabilities = manager.getServerCapabilities(serverId) ?? null;

  const [toolsResult, resourcesResult, promptsResult, resourceTemplatesResult] =
    await Promise.all([
      collectTools(manager, serverId),
      collectResources(manager, serverId),
      collectPrompts(manager, serverId),
      collectResourceTemplates(manager, serverId),
    ]);

  return buildConnectedServerDoctorState({
    initInfo,
    capabilities,
    toolsResult,
    resourcesResult,
    promptsResult,
    resourceTemplatesResult,
  });
}

async function collectTools(
  manager: MCPClientManager,
  serverId: string
): Promise<DoctorToolsCollectionResult> {
  try {
    const result = await listAllTools(manager, { serverId });
    const tools =
      result.tools?.map((tool) => {
        const { _meta: _ignoredMeta, ...toolWithoutMeta } = tool;
        return toolWithoutMeta;
      }) ?? [];
    return {
      tools,
      toolsMetadata: result.toolsMetadata,
      check: okCheck(describeCount(tools.length, "tool")),
    };
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    return {
      tools: [],
      toolsMetadata: {},
      check: errorCheck(structured.message),
      error: structured,
    };
  }
}

async function collectResources(
  manager: MCPClientManager,
  serverId: string
): Promise<DoctorResourcesCollectionResult> {
  try {
    const result = await listAllResources(manager, { serverId });
    const resources = result.resources ?? [];
    return {
      resources,
      check: okCheck(describeCount(resources.length, "resource")),
    };
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    return {
      resources: [],
      check: errorCheck(structured.message),
      error: structured,
    };
  }
}

async function collectPrompts(
  manager: MCPClientManager,
  serverId: string
): Promise<DoctorPromptsCollectionResult> {
  try {
    const result = await listAllPrompts(manager, { serverId });
    const prompts = result.prompts ?? [];
    return {
      prompts,
      check: okCheck(describeCount(prompts.length, "prompt")),
    };
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    return {
      prompts: [],
      check: errorCheck(structured.message),
      error: structured,
    };
  }
}

async function collectResourceTemplates(
  manager: MCPClientManager,
  serverId: string
): Promise<DoctorResourceTemplatesCollectionResult> {
  try {
    const result = await listAllResourceTemplates(manager, { serverId });
    const resourceTemplates = result.resourceTemplates ?? [];
    if (result.unsupported) {
      return {
        resourceTemplates,
        check: skippedCheck("Server does not support resources/templates."),
      };
    }
    return {
      resourceTemplates,
      check: okCheck(
        describeCount(resourceTemplates.length, "resource template")
      ),
    };
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    return {
      resourceTemplates: [],
      check: errorCheck(structured.message),
      error: structured,
    };
  }
}
