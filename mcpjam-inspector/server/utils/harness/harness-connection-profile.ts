import { z } from "zod";
import { harnessElicitationModes } from "./input-host.js";
import type { MCPClientManager } from "@mcpjam/sdk";
import { createHash } from "node:crypto";
import { canonicalJson } from "../tool-approval-token.js";
import {
  DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS,
  resolveModelVisibleMcpToolResults,
} from "@mcpjam/sdk";
import type { ModelVisibleMcpToolResults } from "@mcpjam/sdk/host-config";

const blobVisibility = z
  .object({
    enabled: z.boolean().optional(),
    image: z.boolean().optional(),
    audio: z.boolean().optional(),
    document: z.boolean().optional(),
    video: z.boolean().optional(),
    otherBinary: z.boolean().optional(),
  })
  .strict();
const resourceVisibility = z
  .object({ text: z.boolean().optional(), blob: blobVisibility.optional() })
  .strict();
const resultVisibility = z
  .object({
    directContent: z
      .object({
        text: z.boolean().optional(),
        image: z.boolean().optional(),
        audio: z.boolean().optional(),
      })
      .strict()
      .optional(),
    embeddedResources: resourceVisibility.optional(),
    linkedResources: resourceVisibility.optional(),
  })
  .strict();

export function isEnhancedModelPolicy(
  policy?: ModelVisibleMcpToolResults,
): boolean {
  return (
    (policy === undefined || resultVisibility.safeParse(policy).success) &&
    canonicalJson(resolveModelVisibleMcpToolResults(policy)) ===
      canonicalJson(DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS)
  );
}

/** Only connection behavior crosses the sandbox; credentials and callbacks stay on the server. */
export const harnessConnectionProfileSchema = z
  .object({
    taskMode: z.literal("expose").optional(),
    clientCapabilities: z.record(z.string(), z.unknown()).optional(),
    clientInfo: z
      .object({ name: z.string().optional(), version: z.string().optional() })
      .passthrough()
      .optional(),
    supportedProtocolVersions: z.array(z.string()).optional(),
    mcpProtocolVersion: z
      .enum(["2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"])
      .optional(),
    timeout: z.number().positive().finite().optional(),
    mirrorToolParamHeaders: z.boolean().optional(),
    firstPageOnly: z.boolean().optional(),
    supportsMrtr: z.boolean().optional(),
    suppressListenChannel: z.boolean().optional(),
    dropToolListChanged: z.boolean().optional(),
    toolCallCancellation: z
      .object({
        legacy: z.boolean().optional(),
        modern: z.boolean().optional(),
      })
      .strict()
      .optional(),
    respectToolVisibility: z.boolean().optional(),
    modelVisibleMcpToolResults: resultVisibility.optional(),
  })
  .strict();
export type HarnessConnectionProfile = z.infer<
  typeof harnessConnectionProfileSchema
>;

export function enhancedConnectionProfiles(
  manager: MCPClientManager,
  serverIds: string[],
  respectToolVisibility: boolean,
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults,
  exposeTasks = false,
): Record<string, HarnessConnectionProfile> {
  return Object.fromEntries(
    serverIds.map((id) => [
      id,
      {
        ...harnessConnectionProfile(manager, id),
        ...(exposeTasks ? { taskMode: "expose" as const } : {}),
        mcpProtocolVersion: "2026-07-28",
        respectToolVisibility,
        modelVisibleMcpToolResults,
      },
    ]),
  );
}

/** Apps are bridged only on the qualified stateless upstream protocol. */
export function isEnhancedMcpProfile(
  manager: MCPClientManager,
  serverId: string,
  allowElicitation = false,
  allowTasks = false,
): boolean {
  const info = manager.getInitializationInfo(serverId);
  const caps = info?.clientCapabilities;
  if (
    info?.protocolVersion !== "2026-07-28" ||
    !caps ||
    Object.keys(caps).some(
      (key) =>
        key !== "extensions" &&
        key !== "experimental" &&
        !(allowElicitation && key === "elicitation"),
    )
  )
    return false;
  if (
    caps.elicitation &&
    (!allowElicitation || !harnessElicitationModes(caps).length)
  )
    return false;
  if (caps.experimental && Object.keys(caps.experimental).length) return false;
  const config = manager.getServerConfig(serverId);
  if (
    !config ||
    config.eraCapabilities ||
    (config.capabilities &&
      canonicalJson(config.capabilities) !== canonicalJson(caps))
  )
    return false;
  const extensions = caps.extensions;
  if (!extensions) return allowElicitation && !!caps.elicitation;
  if (
    !extensions ||
    Object.keys(extensions).some((key) => key !== "io.modelcontextprotocol/ui" && !(allowTasks && key === "io.modelcontextprotocol/tasks")) ||
    (!extensions["io.modelcontextprotocol/ui"] && !extensions["io.modelcontextprotocol/tasks"])
  )
    return false;
  const ui = extensions["io.modelcontextprotocol/ui"];
  if (!ui) return allowTasks && !!extensions["io.modelcontextprotocol/tasks"];
  if (
    typeof ui !== "object" ||
    ui === null ||
    Array.isArray(ui) ||
    Object.keys(ui).some((key) => key !== "mimeTypes")
  )
    return false;
  const mimeTypes = (ui as { mimeTypes?: unknown }).mimeTypes;
  if (
    !Array.isArray(mimeTypes) ||
    mimeTypes.length !== 1 ||
    mimeTypes[0] !== "text/html;profile=mcp-app"
  )
    return false;
  return true;
}

export function harnessConnectionFingerprint(
  manager: MCPClientManager,
  serverIds: string[],
  modelResultPolicy?: unknown,
): string {
  return createHash("sha256")
    .update(
      canonicalJson(
        serverIds
          .filter((id) => !!manager.getServerConfig(id))
          .slice()
          .sort()
          .map((id) => [
            id,
            harnessConnectionProfile(manager, id),
            modelResultPolicy ?? null,
          ]),
      ),
    )
    .digest("hex");
}

export function harnessConnectionProfile(
  manager: MCPClientManager,
  serverId: string,
): HarnessConnectionProfile {
  const config = manager.getServerConfig(serverId);
  if (!config) throw new Error("The selected MCP connection is unavailable.");
  const {
    clientInfo,
    supportedProtocolVersions,
    timeout,
    mirrorToolParamHeaders,
    firstPageOnly,
    supportsMrtr,
    suppressListenChannel,
    dropToolListChanged,
    toolCallCancellation,
  } = config;
  return harnessConnectionProfileSchema.parse({
    clientCapabilities:
      manager.getInitializationInfo?.(serverId)?.clientCapabilities ??
      config.clientCapabilities,
    clientInfo,
    supportedProtocolVersions,
    timeout,
    mirrorToolParamHeaders,
    firstPageOnly,
    supportsMrtr,
    suppressListenChannel,
    dropToolListChanged,
    toolCallCancellation,
    mcpProtocolVersion:
      "mcpProtocolVersion" in config ? config.mcpProtocolVersion : undefined,
  });
}
