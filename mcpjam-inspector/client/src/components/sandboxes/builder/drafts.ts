import { isMCPJamProvidedModel, SUPPORTED_MODELS } from "@/shared/types";
import type { SandboxDraftConfig, SandboxStarterDefinition } from "./types";
import type { SandboxSettings } from "@/hooks/useSandboxes";

export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

export function getDefaultHostedModelId(): string {
  return (
    SUPPORTED_MODELS.find((model) =>
      isMCPJamProvidedModel(String(model.id)),
    )?.id?.toString() ?? "openai/gpt-5-mini"
  );
}

export const SANDBOX_STARTERS: SandboxStarterDefinition[] = [
  {
    id: "internal-qa",
    title: "Internal QA sandbox",
    description:
      "A workspace-only sandbox for replaying realistic internal flows.",
    promptHint:
      "QA teammates can use this to verify tool behavior against real company data.",
    createDraft: (defaultModelId) => ({
      name: "Internal QA Sandbox",
      description:
        "Use this sandbox to validate production-ready assistant behavior with the internal team.",
      hostStyle: "claude",
      systemPrompt:
        "You are a careful QA assistant. Prefer explicit reasoning about tool results and call out any uncertainty before taking action.",
      modelId: defaultModelId,
      temperature: 0.4,
      requireToolApproval: true,
      allowGuestAccess: false,
      mode: "invited_only",
      selectedServerIds: [],
      welcomeDialog: { enabled: true, body: "" },
      feedbackDialog: { enabled: true, everyNToolCalls: 1, promptHint: "" },
    }),
  },
  {
    id: "icp-demo",
    title: "ICP demo / share-link sandbox",
    description:
      "A sandbox optimized for external prospects testing through a share link.",
    promptHint:
      "Use this when you want prospects to try your assistant with guided access.",
    createDraft: (defaultModelId) => ({
      name: "ICP Demo Sandbox",
      description:
        "External testing environment for prospects and design partners.",
      hostStyle: "chatgpt",
      systemPrompt:
        "You are a polished product specialist. Use available tools when helpful and keep answers concise, actionable, and easy for first-time users.",
      modelId: defaultModelId,
      temperature: 0.6,
      requireToolApproval: false,
      allowGuestAccess: false,
      mode: "any_signed_in_with_link",
      selectedServerIds: [],
      welcomeDialog: { enabled: true, body: "" },
      feedbackDialog: { enabled: true, everyNToolCalls: 1, promptHint: "" },
    }),
  },
  {
    id: "blank",
    title: "Blank sandbox",
    description: "Start from a clean slate.",
    promptHint:
      "Use this when you want full control over the configuration from the beginning.",
    createDraft: (defaultModelId) => ({
      name: "New Sandbox",
      description: "",
      hostStyle: "claude",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      modelId: defaultModelId,
      temperature: 0.7,
      requireToolApproval: false,
      allowGuestAccess: false,
      mode: "any_signed_in_with_link",
      selectedServerIds: [],
      welcomeDialog: { enabled: true, body: "" },
      feedbackDialog: { enabled: true, everyNToolCalls: 1, promptHint: "" },
    }),
  },
];

export function toDraftConfig(sandbox: SandboxSettings): SandboxDraftConfig {
  return {
    name: sandbox.name,
    description: sandbox.description ?? "",
    hostStyle: sandbox.hostStyle,
    systemPrompt: sandbox.systemPrompt,
    modelId: sandbox.modelId,
    temperature: sandbox.temperature,
    requireToolApproval: sandbox.requireToolApproval,
    allowGuestAccess: sandbox.allowGuestAccess,
    mode: sandbox.mode,
    selectedServerIds: sandbox.servers.map((server) => server.serverId),
    welcomeDialog: {
      enabled: sandbox.welcomeDialog?.enabled ?? true,
      body: sandbox.welcomeDialog?.body ?? "",
    },
    feedbackDialog: {
      enabled: sandbox.feedbackDialog?.enabled ?? true,
      everyNToolCalls: Math.max(
        1,
        sandbox.feedbackDialog?.everyNToolCalls ?? 1,
      ),
      promptHint: sandbox.feedbackDialog?.promptHint ?? "",
    },
  };
}
