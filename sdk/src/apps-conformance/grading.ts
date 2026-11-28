/**
 * MCP Apps grading as a pure function over what a connection already listed
 * and read. The conformance runner calls it after its own `tools/list`,
 * `resources/list` and `resources/read`; anything holding the same lists and
 * read outcomes gets the same check results without a second connection.
 */

import { isAuthorizationRefusal } from "../conformance-authorization.js";
import { APPS_READINESS_CATALOG } from "../conformance-catalog.js";
import type { ConformanceCredentialSource } from "../conformance-login.js";
import {
  MCP_UI_RESOURCE_MIME_TYPE,
  type ListToolsResult,
  type MCPReadResourceResult,
  type MCPResource,
} from "../mcp-client-manager/index.js";
import {
  blockedSkip,
  errorMessage,
  failedResult,
  loginSkip,
  passedResult,
  skippedResult,
} from "./check-results.js";
import {
  decodeHtmlPayload,
  isPlainObject,
  looksLikeHtmlDocument,
  validateUiMeta,
} from "./ui-resource-content.js";
import {
  MCP_APPS_CHECK_IDS,
  type MCPAppsCheckId,
  type MCPAppsCheckResult,
  type MCPAppsConformanceResult,
  type MCPAppsPassedAdvice,
  type MCPAppsReadinessWarning,
  type MCPAppsResourceReadOutcome,
} from "./types.js";

export type UIToolReference = {
  name: string;
  resourceUri: string;
  visibility?: unknown;
  usesLegacyField: boolean;
  hasNestedField: boolean;
  hasLegacyField: boolean;
};

export type MCPListedTool = NonNullable<ListToolsResult["tools"]>[number];

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

/** Failed with the violations, or passed with `passDetails` when there are none. */
function violationsResult(
  id: MCPAppsCheckId,
  stepStartedAt: number,
  violations: string[],
  subject: string,
  failDetails: Record<string, unknown>,
  passDetails: Record<string, unknown>,
): MCPAppsCheckResult {
  const durationMs = Date.now() - stepStartedAt;
  return violations.length > 0
    ? failedResult(
        id,
        durationMs,
        `${violations.length} ${subject} violation(s) found`,
        { violations, ...failDetails },
      )
    : passedResult(id, durationMs, passDetails);
}

export interface MCPAppsResourceReadPlan {
  uiTools: UIToolReference[];
  listedUiResources: MCPResource[];
  listedUiResourceUris: Set<string>;
  /** Every UI resource a tool references or the server lists, once each. */
  uris: string[];
}

/** Which UI resources grading needs read, from the two lists. */
export function planMCPAppsResourceReads(
  tools: MCPListedTool[],
  resources: MCPResource[],
): MCPAppsResourceReadPlan {
  const uiTools = tools
    .map((tool) => extractUiToolReference(tool))
    .filter((tool): tool is UIToolReference => tool !== undefined);
  const listedUiResources = getListedUiResources(resources);
  const listedUiResourceUris = new Set(
    listedUiResources
      .map((resource) => resource.uri)
      .filter((uri): uri is string => typeof uri === "string"),
  );
  const uris = Array.from(
    new Set([
      ...uiTools.map((tool) => tool.resourceUri),
      ...listedUiResourceUris,
    ]),
  );
  return { uiTools, listedUiResources, listedUiResourceUris, uris };
}

export interface MCPAppsGradingInput {
  /** The `tools/list` result; empty when it failed. */
  tools: MCPListedTool[];
  /** Why `tools/list` failed, when it did. */
  toolsError?: unknown;
  /** The `resources/list` result; empty when it failed. */
  resources: MCPResource[];
  /** Why `resources/list` failed, when it did. */
  resourcesError?: unknown;
  /**
   * `resources/read` results or errors for the plan's URIs. Empty when no
   * selected check needs them.
   */
  readOutcomes: MCPAppsResourceReadOutcome[];
  /** The checks to grade; every one when absent. */
  checkIds?: readonly MCPAppsCheckId[];
  /** What the connection sent, to explain a `tools/list` refused for login. */
  credentials?: ConformanceCredentialSource;
}

export interface MCPAppsGrading {
  checks: MCPAppsCheckResult[];
  /** Advice reported beside the verdict rather than as check warnings. */
  readiness: MCPAppsReadinessWarning[];
  /** Advice the checked tools already meet. */
  passedAdvice: MCPAppsPassedAdvice[];
  discovery: MCPAppsConformanceResult["discovery"];
}

/** Grade the MCP Apps checks over lists and reads already in hand. No I/O. */
export function gradeMCPApps(input: MCPAppsGradingInput): MCPAppsGrading {
  const {
    tools,
    toolsError,
    resources,
    resourcesError,
    readOutcomes,
    credentials,
  } = input;
  const selectedCheckIds = new Set(input.checkIds ?? MCP_APPS_CHECK_IDS);
  const checks: MCPAppsCheckResult[] = [];
  const readiness: MCPAppsReadinessWarning[] = [];
  const passedAdvice: MCPAppsPassedAdvice[] = [];
  const {
    uiTools,
    listedUiResources,
    uris: resourceUrisToRead,
  } = planMCPAppsResourceReads(tools, resources);
  // A tool check tools/list never answered: the login's fault on a 401,
  // else blocked by the check that reports the failure.
  const toolsListSkip = (id: MCPAppsCheckId) =>
    isAuthorizationRefusal(toolsError)
      ? loginSkip(id, credentials, toolsError)
      : selectedCheckIds.has("ui-tools-present")
        ? blockedSkip(id, "ui-tools-present")
        : skippedResult(
            id,
            "could-not-run",
            "Skipping check because tools/list did not complete",
          );

  if (selectedCheckIds.has("ui-tools-present")) {
    const stepStartedAt = Date.now();
    if (toolsError) {
      checks.push(
        isAuthorizationRefusal(toolsError)
          ? loginSkip("ui-tools-present", credentials, toolsError)
          : failedResult(
              "ui-tools-present",
              Date.now() - stepStartedAt,
              `tools/list failed: ${errorMessage(toolsError)}`,
              undefined,
              toolsError,
            ),
      );
    } else if (
      uiTools.length === 0 &&
      listedUiResources.length === 0 &&
      !resourcesError &&
      !tools.some((tool) => {
        const meta = isPlainObject(tool._meta) ? tool._meta : {};
        return "ui" in meta || "ui/resourceUri" in meta;
      })
    ) {
      checks.push(
        skippedResult(
          "ui-tools-present",
          "not-applicable",
          "Not applicable"
        )
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
      checks.push(toolsListSkip("ui-tool-metadata-valid"));
    } else if (uiTools.length === 0) {
      checks.push(
        skippedResult(
          "ui-tool-metadata-valid",
          "not-applicable",
          "Skipping check because no MCP Apps tools were discovered",
        ),
      );
    } else {
      const violations: string[] = [];
      const legacyFieldTools: string[] = [];

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
          legacyFieldTools.push(tool.name);
        }
      }

      // apps.mdx: the flat field "is deprecated" and "will be removed
      // before GA". No SHOULD or MAY, so it is a deprecation notice.
      if (legacyFieldTools.length > 0) {
        readiness.push({
          id: "apps-readiness-deprecated-resource-uri",
          checkId: "ui-tool-metadata-valid",
          title:
            APPS_READINESS_CATALOG["apps-readiness-deprecated-resource-uri"]
              .title,
          severity: "warning",
          specStrength: "Deprecation Notice",
          message: `${legacyFieldTools.join(", ")} still use _meta["ui/resourceUri"], which will be removed before GA; use _meta.ui.resourceUri instead.`,
          details: { tools: legacyFieldTools },
          informational: true,
        });
      } else {
        passedAdvice.push({
          id: "apps-readiness-deprecated-resource-uri",
          title:
            APPS_READINESS_CATALOG["apps-readiness-deprecated-resource-uri"]
              .title,
          specStrength: "Deprecation Notice",
        });
      }

      // Tool-name conventions are core MCP rules, so they are advised
      // on every tool by the protocol suite, not here.

      checks.push(
        violationsResult(
          "ui-tool-metadata-valid",
          stepStartedAt,
          violations,
          "tool metadata",
          { uiToolNames: uiTools.map((tool) => tool.name) },
          {
            uiToolCount: uiTools.length,
            uiToolNames: uiTools.map((tool) => tool.name),
          },
        ),
      );
    }
  }

  if (selectedCheckIds.has("ui-tool-input-schema-valid")) {
    const stepStartedAt = Date.now();
    if (toolsError) {
      checks.push(toolsListSkip("ui-tool-input-schema-valid"));
    } else if (uiTools.length === 0) {
      checks.push(
        skippedResult(
          "ui-tool-input-schema-valid",
          "not-applicable",
          "Skipping check because no MCP Apps tools were discovered",
        ),
      );
    } else {
      const violations: string[] = [];

      for (const tool of uiTools) {
        const sourceTool = tools.find((entry) => entry.name === tool.name);
        const schema = sourceTool?.inputSchema;

        if (schema === undefined || schema === null) {
          violations.push(
            `Tool ${tool.name} is missing inputSchema (MUST be a JSON Schema object)`,
          );
        } else if (!isPlainObject(schema)) {
          violations.push(
            `Tool ${tool.name} inputSchema MUST be a JSON Schema object, got ${Array.isArray(schema) ? "array" : typeof schema}`,
          );
        }
      }

      checks.push(
        violationsResult(
          "ui-tool-input-schema-valid",
          stepStartedAt,
          violations,
          "inputSchema",
          { uiToolNames: uiTools.map((tool) => tool.name) },
          {
            uiToolCount: uiTools.length,
            uiToolNames: uiTools.map((tool) => tool.name),
          },
        ),
      );
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
          "not-applicable",
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

      const listedUiResourceUris = listedUiResources.map(
        (resource) => resource.uri,
      );
      checks.push(
        violationsResult(
          "ui-listed-resources-valid",
          stepStartedAt,
          violations,
          "listed UI resource",
          { listedUiResourceUris },
          {
            listedUiResourceCount: listedUiResources.length,
            listedUiResourceUris,
          },
        ),
      );
    }
  }

  if (selectedCheckIds.has("ui-resources-readable")) {
    const stepStartedAt = Date.now();
    if (resourceUrisToRead.length === 0) {
      checks.push(
        skippedResult(
          "ui-resources-readable",
          "not-applicable",
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

  const successfulReads = readOutcomes.filter(
    (outcome): outcome is MCPAppsResourceReadOutcome & {
      result: MCPReadResourceResult;
    } => outcome.result !== undefined,
  );
  const successfulReadDetails = {
    checkedUiResourceCount: successfulReads.length,
    resourceUris: successfulReads.map((outcome) => outcome.uri),
  };

  if (selectedCheckIds.has("ui-resource-contents-valid")) {
    const stepStartedAt = Date.now();

    if (successfulReads.length === 0) {
      checks.push(
        skippedResult(
          "ui-resource-contents-valid",
          "not-applicable",
          "Skipping check because no UI resources were read successfully",
        ),
      );
    } else {
      const violations: string[] = [];

      for (const outcome of successfulReads) {
        const contents = Array.isArray(outcome.result.contents)
          ? outcome.result.contents
          : [];

        if (contents.length !== 1) {
          violations.push(
            `${outcome.uri} must return exactly one content entry from resources/read (got ${contents.length})`,
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

      checks.push(
        violationsResult(
          "ui-resource-contents-valid",
          stepStartedAt,
          violations,
          "UI resource content",
          {},
          successfulReadDetails,
        ),
      );
    }
  }

  if (selectedCheckIds.has("ui-resource-meta-valid")) {
    const stepStartedAt = Date.now();

    if (successfulReads.length === 0) {
      checks.push(
        skippedResult(
          "ui-resource-meta-valid",
          "not-applicable",
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

      checks.push(
        violationsResult(
          "ui-resource-meta-valid",
          stepStartedAt,
          violations,
          "UI resource metadata",
          {},
          successfulReadDetails,
        ),
      );
    }
  }

  return {
    checks,
    readiness,
    passedAdvice,
    discovery: {
      toolCount: tools.length,
      uiToolCount: uiTools.length,
      listedResourceCount: resources.length,
      listedUiResourceCount: listedUiResources.length,
      checkedUiResourceCount: resourceUrisToRead.length,
    },
  };
}
