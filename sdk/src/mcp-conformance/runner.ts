import type { HttpServerConfig } from "../mcp-client-manager/index.js";
import {
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
} from "../mcp-client-manager/mcp-protocol-version.js";
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
  eraSkipMessage,
  failedResult,
  skippedResult,
} from "./checks/helpers.js";
import type {
  MCPCheckCategory,
  MCPCheckEra,
  MCPCheckId,
  MCPCheckResult,
  MCPClientCheckContext,
  MCPClientCheckDefinition,
  MCPConformanceConfig,
  MCPConformanceResult,
  NormalizedMCPConformanceConfig,
} from "./types.js";
import { CHECK_ERAS, MCP_CHECK_CATEGORIES } from "./types.js";
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
    // Flows through `resolveVersionNegotiation`: a modern (stateless) pin
    // makes the underlying Client negotiate the 2026 era so a modern-only
    // server can connect at all. Absent ⇒ legacy negotiation, unchanged.
    mcpProtocolVersion: config.protocolVersion,
  };
}

/**
 * Era gate for a client-backed check. Returns a `skipped` result (never
 * filtered out — the check still appears in the report) when the check does
 * not apply to the run's era per {@link CHECK_ERAS}, else `undefined` so the
 * check runs normally. Skipped checks never fail a run (the verdict is
 * `checks.every(c => c.status !== "failed")`).
 */
function eraGate(
  check: MCPClientCheckDefinition,
  era: MCPCheckEra,
  protocolVersion: string | undefined,
): MCPCheckResult | undefined {
  if (CHECK_ERAS[check.id].includes(era)) {
    return undefined;
  }
  return skippedResult(check, eraSkipMessage(era, protocolVersion));
}

async function safeListResourceTemplates(
  ctx: Pick<MCPClientCheckContext, "manager" | "serverId">,
): Promise<string[]> {
  try {
    // Conformance is a raw-evidence surface: bypass the SEP-2549 response
    // cache so the check always exercises the live wire.
    const result = await ctx.manager.listResourceTemplates(
      ctx.serverId,
      undefined,
      { cacheMode: "bypass" },
    );
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
): Promise<{
  checks: MCPCheckResult[];
  config: NormalizedMCPConformanceConfig;
}> {
  const selectedClientChecks = CLIENT_CHECKS.filter((check) =>
    selectedCheckIds.has(check.id),
  );

  if (selectedClientChecks.length === 0) {
    return { checks: [], config };
  }

  try {
    return await withEphemeralClient(
      createServerConfig(config),
      async (manager, serverId) => {
        // `getManagedClient()` works for every era — the modern pin and the
        // legacy path both resolve to a `ManagedMcpClient` (the stateless
        // preview adapter was removed in Phase 1C; both go through the
        // official Client now). Absent only if connect failed to register a
        // client, which is a genuine error.
        const client = manager.getManagedClient(serverId);
        if (!client) {
          throw new Error("Managed MCP client is unavailable after connect");
        }

        const initializationInfo = manager.getInitializationInfo(serverId);
        const negotiatedProtocolVersion = initializationInfo?.protocolVersion;
        const effectiveConfig: NormalizedMCPConformanceConfig =
          config.protocolVersion === undefined &&
          negotiatedProtocolVersion !== undefined &&
          isKnownProtocolVersion(negotiatedProtocolVersion)
            ? {
                ...config,
                protocolVersion: negotiatedProtocolVersion,
                era: isStatelessProtocolVersion(negotiatedProtocolVersion)
                  ? "modern"
                  : "legacy",
              }
            : config;
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
          config: effectiveConfig,
          initializationInfo,
          availableTools: toolsResult.tools.map((tool) => tool.name),
          availablePrompts: promptsResult.prompts.map((prompt) => prompt.name),
          availableResources: resourcesResult.resources.map((resource) => resource.uri),
          availableResourceTemplates,
        };

        const results: MCPCheckResult[] = [];
        let connectionLost = false;

        for (const check of selectedClientChecks) {
          // Era gate first: an era-inapplicable check is a deterministic skip
          // that never runs `check.run`, so it neither observes nor affects
          // the `connectionLost` sequencing below.
          const eraSkip = eraGate(
            check,
            effectiveConfig.era,
            effectiveConfig.protocolVersion,
          );
          if (eraSkip) {
            results.push(eraSkip);
            continue;
          }

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

        return { checks: results, config: effectiveConfig };
      },
      {
        clientName: config.clientName,
        timeout: config.checkTimeout,
      },
    );

  } catch (error) {
    const checks: MCPCheckResult[] = [];

    // Era gate applies even when the connection could not be established: an
    // era-inapplicable check is a deterministic era-skip, never a failure. On a
    // modern run a connect error must NOT surface a legacy-only check (e.g.
    // `server-initialize`) as failed, or `result.passed` goes false for a check
    // that does not apply to the run's era. The surfaced connect failure is
    // pinned to the first ERA-APPLICABLE check (in legacy that is
    // `selectedClientChecks[0]`, byte-identical to the pre-era-awareness path).
    const firstApplicableCheck = selectedClientChecks.find(
      (check) => !eraGate(check, config.era, config.protocolVersion),
    );

    // Degenerate modern-era selection: EVERY selected client check is
    // legacy-only, so there is no era-applicable check to pin the connect
    // failure to (`firstApplicableCheck` is undefined). The normal loop below
    // would era-skip all of them and the connection error would vanish — the
    // run could report `passed` despite never connecting. Anchor the failure on
    // the first selected check so a genuine connect failure ALWAYS surfaces as
    // at least one failed result. This branch is unreachable in the legacy era
    // (every check applies to `legacy`, so `firstApplicableCheck` is always
    // defined), keeping the legacy path byte-identical to pre-era-awareness.
    if (!firstApplicableCheck) {
      return {
        checks: selectedClientChecks.map((check, index) =>
          index === 0
            ? failedResult(check, 0, errorMessage(error), undefined, error)
            : (eraGate(check, config.era, config.protocolVersion) ??
              skippedResult(
                check,
                "Skipping check because the MCP client session could not be established",
              )),
        ),
        config,
      };
    }

    for (const check of selectedClientChecks) {
      const eraSkip = eraGate(check, config.era, config.protocolVersion);
      if (eraSkip) {
        checks.push(eraSkip);
        continue;
      }

      if (
        check.id === "server-initialize" ||
        check.id === firstApplicableCheck?.id
      ) {
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

    return { checks, config };
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
    const clientRun = await runClientChecks(
      this.config,
      selectedCheckIds,
    );

    const rawContext = {
      config: clientRun.config,
      serverUrl: clientRun.config.serverUrl,
      fetchFn: clientRun.config.fetchFn,
    };

    const [protocolChecks, securityChecks, transportChecks] = await Promise.all([
      runProtocolChecks(rawContext, selectedCheckIds),
      runSecurityChecks(rawContext, selectedCheckIds),
      runTransportChecks(rawContext, selectedCheckIds),
    ]);

    const checks = [
      ...clientRun.checks,
      ...protocolChecks,
      ...securityChecks,
      ...transportChecks,
    ];
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
