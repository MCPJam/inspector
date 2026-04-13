import { Buffer } from "node:buffer";
import {
  MCP_UI_RESOURCE_MIME_TYPE,
  type ListToolsResult,
  type MCPReadResourceResult,
  type MCPResource,
  type MCPServerConfig,
} from "../mcp-client-manager/index.js";
import { withEphemeralClient } from "../operations.js";
import {
  MCP_APPS_CHECK_IDS,
  MCP_APPS_CHECK_CATEGORIES,
  type MCPAppsCheckId,
  type MCPAppsCheckResult,
  type MCPAppsConformanceConfig,
  type MCPAppsConformanceResult,
  type MCPAppsResourceReadOutcome,
  type NormalizedMCPAppsConformanceConfig,
} from "./types.js";
import { normalizeMCPAppsConformanceConfig } from "./validation.js";

const APPS_CHECK_METADATA: Record<
  MCPAppsCheckId,
  Pick<MCPAppsCheckResult, "id" | "category" | "title" | "description">
> = {
  "ui-tools-present": {
    id: "ui-tools-present",
    category: "tools",
    title: "UI Tools Present",
    description:
      "At least one tool advertises MCP Apps UI metadata through _meta.ui.resourceUri or the deprecated ui/resourceUri field.",
  },
  "ui-tool-metadata-valid": {
    id: "ui-tool-metadata-valid",
    category: "tools",
    title: "UI Tool Metadata Valid",
    description:
      "Tools with UI metadata use a ui:// resource URI and valid visibility values.",
  },
  "ui-listed-resources-valid": {
    id: "ui-listed-resources-valid",
    category: "resources",
    title: "Listed UI Resources Valid",
    description:
      "UI resources returned by resources/list use ui:// URIs and the MCP Apps HTML MIME type.",
  },
  "ui-resources-readable": {
    id: "ui-resources-readable",
    category: "resources",
    title: "UI Resources Readable",
    description:
      "Every UI resource referenced by a tool or listed by the server can be fetched with resources/read.",
  },
  "ui-resource-contents-valid": {
    id: "ui-resource-contents-valid",
    category: "resources",
    title: "UI Resource Contents Valid",
    description:
      "UI resource contents use the MCP Apps HTML MIME type and provide exactly one HTML payload via text or blob.",
  },
  "ui-resource-meta-valid": {
    id: "ui-resource-meta-valid",
    category: "resources",
    title: "UI Resource Metadata Valid",
    description:
      "UI resource metadata uses valid csp, permissions, domain, and prefersBorder shapes.",
  },
};

type UIToolReference = {
  name: string;
  resourceUri: string;
  visibility?: unknown;
  usesLegacyField: boolean;
  hasNestedField: boolean;
  hasLegacyField: boolean;
};

type MCPListedTool = NonNullable<ListToolsResult["tools"]>[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function passedResult(
  id: MCPAppsCheckId,
  durationMs: number,
  details?: Record<string, unknown>,
  warnings?: string[],
): MCPAppsCheckResult {
  return {
    ...APPS_CHECK_METADATA[id],
    status: "passed",
    durationMs,
    ...(details ? { details } : {}),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

function failedResult(
  id: MCPAppsCheckId,
  durationMs: number,
  message: string,
  details?: Record<string, unknown>,
  rawError?: unknown,
  warnings?: string[],
): MCPAppsCheckResult {
  return {
    ...APPS_CHECK_METADATA[id],
    status: "failed",
    durationMs,
    error: {
      message,
      ...(rawError === undefined ? {} : { details: rawError }),
    },
    ...(details ? { details } : {}),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

function skippedResult(
  id: MCPAppsCheckId,
  message: string,
  details?: Record<string, unknown>,
): MCPAppsCheckResult {
  return {
    ...APPS_CHECK_METADATA[id],
    status: "skipped",
    durationMs: 0,
    error: { message },
    ...(details ? { details } : {}),
  };
}

function buildCheckSelection(
  config: NormalizedMCPAppsConformanceConfig,
): Set<MCPAppsCheckId> {
  return new Set(config.checkIds ?? MCP_APPS_CHECK_IDS);
}

function summarizeChecks(checks: MCPAppsCheckResult[]) {
  return Object.fromEntries(
    MCP_APPS_CHECK_CATEGORIES.map((category) => {
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
  ) as MCPAppsConformanceResult["categorySummary"];
}

function buildSummary(checks: MCPAppsCheckResult[]): string {
  const passed = checks.filter((check) => check.status === "passed").length;
  const failed = checks.filter((check) => check.status === "failed").length;
  const skipped = checks.filter((check) => check.status === "skipped").length;
  return `${passed}/${checks.length} checks passed, ${failed} failed, ${skipped} skipped`;
}

function extractUiToolReference(tool: MCPListedTool): UIToolReference | undefined {
  const toolMeta = isPlainObject(tool._meta) ? tool._meta : undefined;
  const nested = isPlainObject(toolMeta?.ui) ? toolMeta.ui : undefined;
  const nestedResourceUri =
    typeof nested?.resourceUri === "string" ? nested.resourceUri : undefined;
  const legacyResourceUri =
    typeof toolMeta?.["ui/resourceUri"] === "string"
      ? (toolMeta["ui/resourceUri"] as string)
      : undefined;

  if (!nestedResourceUri && !legacyResourceUri) {
    return undefined;
  }

  return {
    name: tool.name,
    resourceUri: nestedResourceUri ?? legacyResourceUri!,
    visibility: nested?.visibility,
    usesLegacyField: !nestedResourceUri && !!legacyResourceUri,
    hasNestedField: !!nestedResourceUri,
    hasLegacyField: !!legacyResourceUri,
  };
}

function getListedUiResources(resources: MCPResource[]): MCPResource[] {
  return resources.filter((resource) => {
    const uri = typeof resource.uri === "string" ? resource.uri : "";
    return (
      uri.startsWith("ui://") || resource.mimeType === MCP_UI_RESOURCE_MIME_TYPE
    );
  });
}

function decodeHtmlPayload(content: Record<string, unknown>): {
  hasText: boolean;
  hasBlob: boolean;
  html: string;
} {
  const text = typeof content.text === "string" ? content.text : undefined;
  const blob = typeof content.blob === "string" ? content.blob : undefined;

  if (text !== undefined) {
    return {
      hasText: true,
      hasBlob: false,
      html: text,
    };
  }

  if (blob !== undefined) {
    return {
      hasText: false,
      hasBlob: true,
      html: Buffer.from(blob, "base64").toString("utf8"),
    };
  }

  return {
    hasText: false,
    hasBlob: false,
    html: "",
  };
}

function looksLikeHtmlDocument(html: string): boolean {
  const normalized = html.trim().toLowerCase();
  return (
    normalized.startsWith("<!doctype html") ||
    normalized.includes("<html")
  );
}

function validateUiMeta(
  meta: unknown,
  uri: string,
  contentIndex: number,
): string[] {
  if (meta === undefined) {
    return [];
  }

  if (!isPlainObject(meta)) {
    return [`${uri} contents[${contentIndex}] _meta must be an object`];
  }

  const ui = meta.ui;
  if (ui === undefined) {
    return [];
  }

  if (!isPlainObject(ui)) {
    return [`${uri} contents[${contentIndex}] _meta.ui must be an object`];
  }

  const violations: string[] = [];
  const csp = ui.csp;
  if (csp !== undefined) {
    if (!isPlainObject(csp)) {
      violations.push(`${uri} contents[${contentIndex}] _meta.ui.csp must be an object`);
    } else {
      for (const key of [
        "connectDomains",
        "resourceDomains",
        "frameDomains",
        "baseUriDomains",
      ] as const) {
        const value = csp[key];
        if (
          value !== undefined &&
          (!Array.isArray(value) ||
            value.some((entry) => typeof entry !== "string" || entry.trim().length === 0))
        ) {
          violations.push(
            `${uri} contents[${contentIndex}] _meta.ui.csp.${key} must be an array of non-empty strings`,
          );
        }
      }
    }
  }

  const permissions = ui.permissions;
  if (permissions !== undefined) {
    if (!isPlainObject(permissions)) {
      violations.push(
        `${uri} contents[${contentIndex}] _meta.ui.permissions must be an object`,
      );
    } else {
      const allowedPermissions = new Set([
        "camera",
        "microphone",
        "geolocation",
        "clipboardWrite",
      ]);
      for (const [key, value] of Object.entries(permissions)) {
        if (!allowedPermissions.has(key)) {
          violations.push(
            `${uri} contents[${contentIndex}] _meta.ui.permissions.${key} is not a recognized permission`,
          );
          continue;
        }
        if (!isPlainObject(value)) {
          violations.push(
            `${uri} contents[${contentIndex}] _meta.ui.permissions.${key} must be an object`,
          );
        }
      }
    }
  }

  if (ui.domain !== undefined) {
    if (typeof ui.domain !== "string" || ui.domain.trim().length === 0) {
      violations.push(
        `${uri} contents[${contentIndex}] _meta.ui.domain must be a non-empty string`,
      );
    }
  }

  if (
    ui.prefersBorder !== undefined &&
    typeof ui.prefersBorder !== "boolean"
  ) {
    violations.push(
      `${uri} contents[${contentIndex}] _meta.ui.prefersBorder must be a boolean`,
    );
  }

  return violations;
}

async function readUiResources(
  manager: {
    readResource: (
      serverId: string,
      params: { uri: string },
    ) => Promise<MCPReadResourceResult>;
  },
  serverId: string,
  resourceUris: string[],
  uiTools: UIToolReference[],
  listedUiResourceUris: Set<string>,
): Promise<MCPAppsResourceReadOutcome[]> {
  return Promise.all(
    resourceUris.map(async (uri) => {
      try {
        const result = await manager.readResource(serverId, { uri });
        return {
          uri,
          referencedByTools: uiTools
            .filter((tool) => tool.resourceUri === uri)
            .map((tool) => tool.name),
          listed: listedUiResourceUris.has(uri),
          result,
        };
      } catch (error) {
        return {
          uri,
          referencedByTools: uiTools
            .filter((tool) => tool.resourceUri === uri)
            .map((tool) => tool.name),
          listed: listedUiResourceUris.has(uri),
          error,
        };
      }
    }),
  );
}

function buildConnectionFailureResult(
  config: NormalizedMCPAppsConformanceConfig,
  error: unknown,
  startedAt: number,
): MCPAppsConformanceResult {
  const selectedCheckIds = buildCheckSelection(config);
  const checks: MCPAppsCheckResult[] = [];

  for (const checkId of selectedCheckIds) {
    if (checkId === "ui-tools-present") {
      checks.push(
        failedResult(
          checkId,
          Date.now() - startedAt,
          errorMessage(error),
          undefined,
          error,
        ),
      );
    } else {
      checks.push(
        skippedResult(
          checkId,
          "Skipping check because the MCP server could not be connected",
        ),
      );
    }
  }

  return {
    passed: false,
    target: config.target,
    checks,
    summary: buildSummary(checks),
    durationMs: Date.now() - startedAt,
    categorySummary: summarizeChecks(checks),
    discovery: {
      toolCount: 0,
      uiToolCount: 0,
      listedResourceCount: 0,
      listedUiResourceCount: 0,
      checkedUiResourceCount: 0,
    },
  };
}

export class MCPAppsConformanceTest {
  private readonly config: NormalizedMCPAppsConformanceConfig;

  constructor(config: MCPAppsConformanceConfig) {
    this.config = normalizeMCPAppsConformanceConfig(config);
  }

  async run(): Promise<MCPAppsConformanceResult> {
    const startedAt = Date.now();
    const selectedCheckIds = buildCheckSelection(this.config);

    try {
      return await withEphemeralClient(
        this.config.serverConfig as MCPServerConfig,
        async (manager, serverId) => {
          const checks: MCPAppsCheckResult[] = [];
          let tools: MCPListedTool[] = [];
          let resources: MCPResource[] = [];
          let toolsError: unknown;
          let resourcesError: unknown;

          try {
            const result = await manager.listTools(serverId);
            tools = result.tools ?? [];
          } catch (error) {
            toolsError = error;
          }

          try {
            const result = await manager.listResources(serverId);
            resources = result.resources ?? [];
          } catch (error) {
            resourcesError = error;
          }

          const uiTools = tools
            .map((tool) => extractUiToolReference(tool))
            .filter((tool): tool is UIToolReference => tool !== undefined);
          const listedUiResources = getListedUiResources(resources);
          const listedUiResourceUris = new Set(
            listedUiResources
              .map((resource) => resource.uri)
              .filter((uri): uri is string => typeof uri === "string"),
          );
          const resourceUrisToRead = Array.from(
            new Set([
              ...uiTools.map((tool) => tool.resourceUri),
              ...listedUiResourceUris,
            ]),
          );

          let readOutcomes: MCPAppsResourceReadOutcome[] = [];
          if (
            (selectedCheckIds.has("ui-resources-readable") ||
              selectedCheckIds.has("ui-resource-contents-valid") ||
              selectedCheckIds.has("ui-resource-meta-valid")) &&
            resourceUrisToRead.length > 0
          ) {
            readOutcomes = await readUiResources(
              manager,
              serverId,
              resourceUrisToRead,
              uiTools,
              listedUiResourceUris,
            );
          }

          if (selectedCheckIds.has("ui-tools-present")) {
            const stepStartedAt = Date.now();
            if (toolsError) {
              checks.push(
                failedResult(
                  "ui-tools-present",
                  Date.now() - stepStartedAt,
                  `tools/list failed: ${errorMessage(toolsError)}`,
                  undefined,
                  toolsError,
                ),
              );
            } else if (uiTools.length === 0) {
              checks.push(
                failedResult(
                  "ui-tools-present",
                  Date.now() - stepStartedAt,
                  "No tools advertise MCP Apps UI resources",
                  {
                    toolCount: tools.length,
                    listedUiResourceCount: listedUiResources.length,
                  },
                ),
              );
            } else {
              checks.push(
                passedResult("ui-tools-present", Date.now() - stepStartedAt, {
                  toolCount: tools.length,
                  uiToolCount: uiTools.length,
                  uiToolNames: uiTools.map((tool) => tool.name),
                  resourceUris: uiTools.map((tool) => tool.resourceUri),
                }),
              );
            }
          }

          if (selectedCheckIds.has("ui-tool-metadata-valid")) {
            const stepStartedAt = Date.now();
            if (toolsError) {
              checks.push(
                skippedResult(
                  "ui-tool-metadata-valid",
                  "Skipping check because tools/list did not complete",
                ),
              );
            } else if (uiTools.length === 0) {
              checks.push(
                skippedResult(
                  "ui-tool-metadata-valid",
                  "Skipping check because no MCP Apps tools were discovered",
                ),
              );
            } else {
              const violations: string[] = [];
              const warnings: string[] = [];

              for (const tool of uiTools) {
                const sourceTool = tools.find((entry) => entry.name === tool.name);
                const toolMeta = isPlainObject(sourceTool?._meta)
                  ? sourceTool._meta
                  : undefined;
                const nested = isPlainObject(toolMeta?.ui) ? toolMeta.ui : undefined;
                const nestedResourceUri =
                  typeof nested?.resourceUri === "string"
                    ? nested.resourceUri
                    : undefined;
                const legacyResourceUri =
                  typeof toolMeta?.["ui/resourceUri"] === "string"
                    ? (toolMeta["ui/resourceUri"] as string)
                    : undefined;

                if (
                  nestedResourceUri &&
                  legacyResourceUri &&
                  nestedResourceUri !== legacyResourceUri
                ) {
                  violations.push(
                    `Tool ${tool.name} defines conflicting ui.resourceUri and ui/resourceUri values`,
                  );
                }

                if (!tool.resourceUri.startsWith("ui://")) {
                  violations.push(
                    `Tool ${tool.name} references "${tool.resourceUri}", which must use the ui:// scheme`,
                  );
                }

                if (nested?.visibility !== undefined) {
                  if (!Array.isArray(nested.visibility)) {
                    violations.push(
                      `Tool ${tool.name} _meta.ui.visibility must be an array`,
                    );
                  } else if (nested.visibility.length === 0) {
                    violations.push(
                      `Tool ${tool.name} _meta.ui.visibility must not be empty`,
                    );
                  } else {
                    const invalidValues = nested.visibility.filter(
                      (value) => value !== "model" && value !== "app",
                    );
                    if (invalidValues.length > 0) {
                      violations.push(
                        `Tool ${tool.name} uses unsupported visibility values: ${invalidValues.join(", ")}`,
                      );
                    }
                  }
                }

                if (tool.usesLegacyField) {
                  warnings.push(
                    `Tool ${tool.name} uses deprecated _meta["ui/resourceUri"]; prefer _meta.ui.resourceUri`,
                  );
                }
              }

              if (violations.length > 0) {
                checks.push(
                  failedResult(
                    "ui-tool-metadata-valid",
                    Date.now() - stepStartedAt,
                    `${violations.length} tool metadata violation(s) found`,
                    {
                      violations,
                      uiToolNames: uiTools.map((tool) => tool.name),
                    },
                    undefined,
                    warnings,
                  ),
                );
              } else {
                checks.push(
                  passedResult(
                    "ui-tool-metadata-valid",
                    Date.now() - stepStartedAt,
                    {
                      uiToolCount: uiTools.length,
                      uiToolNames: uiTools.map((tool) => tool.name),
                    },
                    warnings,
                  ),
                );
              }
            }
          }

          if (selectedCheckIds.has("ui-listed-resources-valid")) {
            const stepStartedAt = Date.now();
            if (resourcesError) {
              checks.push(
                failedResult(
                  "ui-listed-resources-valid",
                  Date.now() - stepStartedAt,
                  `resources/list failed: ${errorMessage(resourcesError)}`,
                  undefined,
                  resourcesError,
                ),
              );
            } else if (listedUiResources.length === 0) {
              checks.push(
                skippedResult(
                  "ui-listed-resources-valid",
                  "Skipping check because resources/list did not expose any UI resources",
                ),
              );
            } else {
              const violations: string[] = [];

              for (const resource of listedUiResources) {
                if (!resource.uri.startsWith("ui://")) {
                  violations.push(
                    `Listed resource ${resource.name} uses "${resource.uri}" but UI resources must use the ui:// scheme`,
                  );
                }
                if (resource.mimeType !== MCP_UI_RESOURCE_MIME_TYPE) {
                  violations.push(
                    `Listed UI resource ${resource.uri} uses mimeType "${resource.mimeType ?? "<missing>"}" instead of "${MCP_UI_RESOURCE_MIME_TYPE}"`,
                  );
                }
              }

              if (violations.length > 0) {
                checks.push(
                  failedResult(
                    "ui-listed-resources-valid",
                    Date.now() - stepStartedAt,
                    `${violations.length} listed UI resource violation(s) found`,
                    {
                      violations,
                      listedUiResourceUris: listedUiResources.map(
                        (resource) => resource.uri,
                      ),
                    },
                  ),
                );
              } else {
                checks.push(
                  passedResult(
                    "ui-listed-resources-valid",
                    Date.now() - stepStartedAt,
                    {
                      listedUiResourceCount: listedUiResources.length,
                      listedUiResourceUris: listedUiResources.map(
                        (resource) => resource.uri,
                      ),
                    },
                  ),
                );
              }
            }
          }

          if (selectedCheckIds.has("ui-resources-readable")) {
            const stepStartedAt = Date.now();
            if (resourceUrisToRead.length === 0) {
              checks.push(
                skippedResult(
                  "ui-resources-readable",
                  "Skipping check because no UI resources were discovered",
                ),
              );
            } else {
              const failures = readOutcomes.filter((outcome) => outcome.error);
              if (failures.length > 0) {
                checks.push(
                  failedResult(
                    "ui-resources-readable",
                    Date.now() - stepStartedAt,
                    `${failures.length} UI resource read(s) failed`,
                    {
                      failures: failures.map((outcome) => ({
                        uri: outcome.uri,
                        referencedByTools: outcome.referencedByTools,
                        listed: outcome.listed,
                        error: errorMessage(outcome.error),
                      })),
                    },
                  ),
                );
              } else {
                checks.push(
                  passedResult("ui-resources-readable", Date.now() - stepStartedAt, {
                    checkedUiResourceCount: readOutcomes.length,
                    resourceUris: readOutcomes.map((outcome) => outcome.uri),
                  }),
                );
              }
            }
          }

          if (selectedCheckIds.has("ui-resource-contents-valid")) {
            const stepStartedAt = Date.now();
            const successfulReads = readOutcomes.filter(
              (outcome): outcome is MCPAppsResourceReadOutcome & {
                result: MCPReadResourceResult;
              } => outcome.result !== undefined,
            );

            if (successfulReads.length === 0) {
              checks.push(
                skippedResult(
                  "ui-resource-contents-valid",
                  "Skipping check because no UI resources were read successfully",
                ),
              );
            } else {
              const violations: string[] = [];

              for (const outcome of successfulReads) {
                const contents = Array.isArray(outcome.result.contents)
                  ? outcome.result.contents
                  : [];

                if (contents.length === 0) {
                  violations.push(
                    `${outcome.uri} returned no contents from resources/read`,
                  );
                  continue;
                }

                contents.forEach((content, index) => {
                  if (!isPlainObject(content)) {
                    violations.push(
                      `${outcome.uri} contents[${index}] must be an object`,
                    );
                    return;
                  }

                  if (content.uri !== outcome.uri) {
                    violations.push(
                      `${outcome.uri} contents[${index}] returned uri "${String(content.uri)}" instead of "${outcome.uri}"`,
                    );
                  }

                  if (content.mimeType !== MCP_UI_RESOURCE_MIME_TYPE) {
                    violations.push(
                      `${outcome.uri} contents[${index}] returned mimeType "${String(content.mimeType ?? "<missing>")}" instead of "${MCP_UI_RESOURCE_MIME_TYPE}"`,
                    );
                  }

                  const hasText =
                    "text" in content && typeof content.text === "string";
                  const hasBlob =
                    "blob" in content && typeof content.blob === "string";
                  if (hasText === hasBlob) {
                    violations.push(
                      `${outcome.uri} contents[${index}] must provide exactly one of text or blob`,
                    );
                    return;
                  }

                  try {
                    const payload = decodeHtmlPayload(content);
                    if (payload.html.trim().length === 0) {
                      violations.push(
                        `${outcome.uri} contents[${index}] HTML payload must not be empty`,
                      );
                    } else if (!looksLikeHtmlDocument(payload.html)) {
                      violations.push(
                        `${outcome.uri} contents[${index}] must contain an HTML document`,
                      );
                    }
                  } catch (error) {
                    violations.push(
                      `${outcome.uri} contents[${index}] blob could not be decoded as UTF-8 HTML: ${errorMessage(error)}`,
                    );
                  }
                });
              }

              if (violations.length > 0) {
                checks.push(
                  failedResult(
                    "ui-resource-contents-valid",
                    Date.now() - stepStartedAt,
                    `${violations.length} UI resource content violation(s) found`,
                    { violations },
                  ),
                );
              } else {
                checks.push(
                  passedResult(
                    "ui-resource-contents-valid",
                    Date.now() - stepStartedAt,
                    {
                      checkedUiResourceCount: successfulReads.length,
                      resourceUris: successfulReads.map((outcome) => outcome.uri),
                    },
                  ),
                );
              }
            }
          }

          if (selectedCheckIds.has("ui-resource-meta-valid")) {
            const stepStartedAt = Date.now();
            const successfulReads = readOutcomes.filter(
              (outcome): outcome is MCPAppsResourceReadOutcome & {
                result: MCPReadResourceResult;
              } => outcome.result !== undefined,
            );

            if (successfulReads.length === 0) {
              checks.push(
                skippedResult(
                  "ui-resource-meta-valid",
                  "Skipping check because no UI resources were read successfully",
                ),
              );
            } else {
              const violations: string[] = [];

              for (const outcome of successfulReads) {
                const contents = Array.isArray(outcome.result.contents)
                  ? outcome.result.contents
                  : [];
                contents.forEach((content, index) => {
                  if (!isPlainObject(content)) {
                    return;
                  }
                  violations.push(
                    ...validateUiMeta(content._meta, outcome.uri, index),
                  );
                });
              }

              if (violations.length > 0) {
                checks.push(
                  failedResult(
                    "ui-resource-meta-valid",
                    Date.now() - stepStartedAt,
                    `${violations.length} UI resource metadata violation(s) found`,
                    { violations },
                  ),
                );
              } else {
                checks.push(
                  passedResult("ui-resource-meta-valid", Date.now() - stepStartedAt, {
                    checkedUiResourceCount: successfulReads.length,
                    resourceUris: successfulReads.map((outcome) => outcome.uri),
                  }),
                );
              }
            }
          }

          return {
            passed: checks.every((check) => check.status !== "failed"),
            target: this.config.target,
            checks,
            summary: buildSummary(checks),
            durationMs: Date.now() - startedAt,
            categorySummary: summarizeChecks(checks),
            discovery: {
              toolCount: tools.length,
              uiToolCount: uiTools.length,
              listedResourceCount: resources.length,
              listedUiResourceCount: listedUiResources.length,
              checkedUiResourceCount: resourceUrisToRead.length,
            },
          };
        },
        {
          serverId: "__apps_conformance__",
          clientName: "mcpjam-sdk-apps-conformance",
          timeout: this.config.timeout,
          rpcLogger: this.config.serverConfig.rpcLogger,
        },
      );
    } catch (error) {
      return buildConnectionFailureResult(this.config, error, startedAt);
    }
  }
}
