/**
 * Claude web and ChatGPT web as registry entries.
 *
 * Nothing runs in a box for these: MCPJam drives the vendor's own website in a
 * browser on a project's web account (`real-ui/`), and the vendor's own MCP
 * client reaches each server through MCPJam's forwarding endpoint
 * (`/mcp/<connectorId>`). The registry still carries them so every shared
 * gate (surfaces, approval, model rules, the MCP route planner) reads one set
 * of declarations, the same way it does for the CLI runtimes.
 */
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { HARNESS_REASONING_EFFORTS } from "@mcpjam/sdk/host-config/internal";
import { HARNESS_DESCRIPTORS } from "@/shared/harness-descriptors";
import { HARNESS_MCP_DELIVERY } from "@/shared/harness-mcp-delivery";
import {
  harnessModelSupportAtPinnedVersion,
  harnessPinnedVersion,
} from "@/shared/harness-model-support";
import {
  WEB_CLIENT_RUNTIME_IDS,
  type WebClientVendor,
} from "@/shared/web-clients";
import { parseHarnessToolName } from "./mcp-config.js";
import { HARNESS_SKILLS } from "./skills-descriptor.js";
import type { HarnessRuntimeAdapter } from "./registry.js";

function webClientAdapter(vendor: WebClientVendor): HarnessRuntimeAdapter {
  const id = WEB_CLIENT_RUNTIME_IDS[vendor];
  const descriptor = HARNESS_DESCRIPTORS[id];
  // The app picks the model on the account; the evidence table holds the host
  // to the vendor's own models, so a run is never recorded under another's.
  const modelSupport = (modelId: string) =>
    harnessModelSupportAtPinnedVersion({ harnessId: id, modelId });
  return {
    id,
    displayName: descriptor.displayName,
    promptImageInput: false,
    supportedReasoningEfforts: HARNESS_REASONING_EFFORTS[id],
    // A browser, not a cloud computer: the runtime finds its browser itself
    // and fails the run, never the server, when there is none.
    requiresComputer: false,
    modelAccess: descriptor.modelAccess,
    webAccount: { vendor },
    defaultPermissionMode: "allow-all",
    // The app's own tools (search, files, its sandbox) run on the vendor's
    // servers where nothing of MCPJam's can pause them.
    supportsNativeToolApproval: false,
    approvalPermissionMode: "allow-all",
    // Every MCP call reaches the forwarding endpoint, which asks the turn's
    // approval gate before anything goes upstream.
    supportsMcpToolApproval: true,
    supportsHostExecutedToolApproval: false,
    mcpDelivery: HARNESS_MCP_DELIVERY[id],
    mcpNativeDelivery: "web-connector",
    supportsSkills: false,
    skills: HARNESS_SKILLS[id],
    conversationState: null,
    supportsPluginBundles: false,
    listBuiltinTools: () => [],
    pinnedRuntimeVersion: harnessPinnedVersion(id),
    modelSupport,
    supportsModel: (modelId) => modelSupport(modelId).status === "supported",
    // The vendor's client calls tools by their own names; the forwarding
    // endpoint knows which server each connector belongs to.
    parseToolName: parseHarnessToolName,
    createHarness(): HarnessAgentAdapter {
      throw new Error(
        `${descriptor.displayName} runs in a browser, so it has no runtime to start in a box.`,
      );
    },
  };
}

export const claudeWebAdapter = webClientAdapter("claude");
export const chatgptWebAdapter = webClientAdapter("chatgpt");
