import type { HttpServerConfig } from "../mcp-client-manager/index.js";
import {
  listPrompts,
  listResources,
  listTools,
  withEphemeralClient,
} from "../operations.js";
import { CORE_CHECKS } from "./checks/core.js";
import { RESOURCE_CHECKS } from "./checks/resources.js";
import { runProtocolChecks } from "./checks/protocol.js";
import { runSecurityChecks } from "./checks/security.js";
import { runTransportChecks } from "./checks/transport.js";
import { TOOL_CHECKS } from "./checks/tools.js";
import { PROMPT_CHECKS } from "./checks/prompts.js";
import {
  errorMessage,
  failedResult,
  skippedResult,
} from "./checks/helpers.js";
import type {
  MCPCheckCategory,
  MCPCheckId,
  MCPCheckResult,
  MCPClientCheckContext,
  MCPConformanceConfig,
  MCPConformanceResult,
  NormalizedMCPConformanceConfig,
} from "./types.js";
import { MCP_CHECK_CATEGORIES } from "./types.js";
import { normalizeMCPConformanceConfig } from "./validation.js";

const CLIENT_CHECKS = [
  ...CORE_CHECKS,
  ...TOOL_CHECKS,
  ...PROMPT_CHECKS,
  ...RESOURCE_CHECKS,
] as const;

const RAW_CHECK_CATEGORY_ENTRIES: ReadonlyArray<
  readonly [MCPCheckId, MCPCheckCategory]
> = [
  ["protocol-invalid-method-error", "protocol"],
  ["localhost-host-rebinding-rejected", "security"],
  ["localhost-host-valid-accepted", "security"],
  ["server-sse-polling-session", "transport"],
  ["server-accepts-multiple-post-streams", "transport"],
  ["server-sse-streams-functional", "transport"],
];

const CHECK_CATEGORY_BY_ID = new Map<MCPCheckId, MCPCheckCategory>(
  [
    ...CLIENT_CHECKS.map(
      (check): readonly [MCPCheckId, MCPCheckCategory] => [
        check.id,
        check.category,
      ],
    ),
    ...RAW_CHECK_CATEGORY_ENTRIES,
  ],
);

function buildCheckSelection(
  config: NormalizedMCPConformanceConfig,
): Set<MCPCheckId> {
  if (config.checkIds?.length) {
    return new Set(config.checkIds);
  }

  return new Set(
    [...CHECK_CATEGORY_BY_ID.entries()]
      .filter(([, category]) => config.categories.includes(category))
      .map(([checkId]) => checkId),
  );
}

function summarizeChecks(checks: MCPCheckResult[]) {
  return Object.fromEntries(
    MCP_CHECK_CATEGORIES.map((category) => {
      const categoryChecks = checks.filter((check) => check.category === category);
      return [
        category,
        {
          total: categoryChecks.length,
          passed: categoryChecks.filter((check) => check.status === "passed").length,
          failed: categoryChecks.filter((check) => check.status === "failed").length,
          skipped: categoryChecks.filter((check) => check.status === "skipped").length,
        },
      ];
    }),
  ) as MCPConformanceResult["categorySummary"];
}

function buildSummary(checks: MCPCheckResult[]): string {
  const passed = checks.filter((check) => check.status === "passed").length;
  const failed = checks.filter((check) => check.status === "failed").length;
  const skipped = checks.filter((check) => check.status === "skipped").length;
  return `${passed}/${checks.length} checks passed, ${failed} failed, ${skipped} skipped`;
}

function createServerConfig(
  config: NormalizedMCPConformanceConfig,
): HttpServerConfig {
  return {
    url: config.serverUrl,
    accessToken: config.accessToken,
    requestInit: config.customHeaders
      ? { headers: config.customHeaders }
      : undefined,
    timeout: config.checkTimeout,
  };
}

async function safeListResourceTemplates(
  ctx: Pick<MCPClientCheckContext, "manager" | "serverId">,
): Promise<string[]> {
  try {
    const result = await ctx.manager.listResourceTemplates(ctx.serverId);
    return (result.resourceTemplates ?? []).map((template) => template.uriTemplate);
  } catch {
    return [];
  }
}

async function safeListTools(
  ctx: Pick<MCPClientCheckContext, "manager" | "serverId">,
) {
  try {
    return await listTools(ctx.manager, { serverId: ctx.serverId });
  } catch {
    return {
      tools: [],
      nextCursor: undefined,
    };
  }
}

async function safeListPrompts(
  ctx: Pick<MCPClientCheckContext, "manager" | "serverId">,
) {
  try {
    return await listPrompts(ctx.manager, { serverId: ctx.serverId });
  } catch {
    return {
      prompts: [],
      nextCursor: undefined,
    };
  }
}

async function safeListResources(
  ctx: Pick<MCPClientCheckContext, "manager" | "serverId">,
) {
  try {
    return await listResources(ctx.manager, { serverId: ctx.serverId });
  } catch {
    return {
      resources: [],
      nextCursor: undefined,
    };
  }
}

async function runClientChecks(
  config: NormalizedMCPConformanceConfig,
  selectedCheckIds: Set<MCPCheckId>,
): Promise<MCPCheckResult[]> {
  const selectedClientChecks = CLIENT_CHECKS.filter((check) =>
    selectedCheckIds.has(check.id),
  );

  if (selectedClientChecks.length === 0) {
    return [];
  }

  try {
    const checks = await withEphemeralClient(
      createServerConfig(config),
      async (manager, serverId) => {
        const client = manager.getClient(serverId);
        if (!client) {
          throw new Error("Underlying MCP client is unavailable after connect");
        }

        const initializationInfo = manager.getInitializationInfo(serverId);
        const [toolsResult, promptsResult, resourcesResult, availableResourceTemplates] =
          await Promise.all([
            safeListTools({ manager, serverId }),
            safeListPrompts({ manager, serverId }),
            safeListResources({ manager, serverId }),
            safeListResourceTemplates({ manager, serverId }),
          ]);

        const ctx: MCPClientCheckContext = {
          manager,
          client,
          serverId,
          config,
          initializationInfo,
          availableTools: toolsResult.tools.map((tool) => tool.name),
          availablePrompts: promptsResult.prompts.map((prompt) => prompt.name),
          availableResources: resourcesResult.resources.map((resource) => resource.uri),
          availableResourceTemplates,
        };

        const results: MCPCheckResult[] = [];
        let connectionLost = false;

        for (const check of selectedClientChecks) {
          if (connectionLost) {
            results.push(
              skippedResult(
                check,
                "Skipping check because the MCP client session is no longer healthy",
              ),
            );
            continue;
          }

          try {
            results.push(await check.run(ctx));
          } catch (error) {
            results.push(
              failedResult(
                check,
                0,
                errorMessage(error),
                undefined,
                error,
              ),
            );
            connectionLost = true;
          }
        }

        return results;
      },
      {
        clientName: config.clientName,
        timeout: config.checkTimeout,
      },
    );

    return checks;
  } catch (error) {
    const firstCheck = selectedClientChecks[0];
    const checks: MCPCheckResult[] = [];

    for (const check of selectedClientChecks) {
      if (check.id === "server-initialize" || check.id === firstCheck.id) {
        checks.push(
          failedResult(
            check,
            0,
            errorMessage(error),
            undefined,
            error,
          ),
        );
      } else {
        checks.push(
          skippedResult(
            check,
            "Skipping check because the MCP client session could not be established",
          ),
        );
      }
    }

    return checks;
  }
}

export class MCPConformanceTest {
  private readonly config: NormalizedMCPConformanceConfig;

  constructor(config: MCPConformanceConfig) {
    this.config = normalizeMCPConformanceConfig(config);
  }

  async run(): Promise<MCPConformanceResult> {
    const startedAt = Date.now();
    const selectedCheckIds = buildCheckSelection(this.config);
    const clientChecks = await runClientChecks(
      this.config,
      selectedCheckIds,
    );

    const rawContext = {
      config: this.config,
      serverUrl: this.config.serverUrl,
      fetchFn: this.config.fetchFn,
    };

    const [protocolChecks, securityChecks, transportChecks] = await Promise.all([
      runProtocolChecks(rawContext, selectedCheckIds),
      runSecurityChecks(rawContext, selectedCheckIds),
      runTransportChecks(rawContext, selectedCheckIds),
    ]);

    const checks = [...clientChecks, ...protocolChecks, ...securityChecks, ...transportChecks];
    const categorySummary = summarizeChecks(checks);

    return {
      passed: checks.every((check) => check.status !== "failed"),
      serverUrl: this.config.serverUrl,
      checks,
      summary: buildSummary(checks),
      durationMs: Date.now() - startedAt,
      categorySummary,
    };
  }
}
