import {
  isMCPJamProvidedModel,
  isModelSupported,
  SUPPORTED_MODELS,
} from "@/shared/types";
import type { ChatboxDraftConfig, ChatboxStarterDefinition } from "./types";
import type { ChatboxSettings } from "@/hooks/useChatboxes";

export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

/** Default temperature for template starters (matches blank; personas do not vary temperature). */
const TEMPLATE_TEMPERATURE = 0.7;

const WELCOME_BODY_INTERNAL_QA = [
  "Welcome to Internal QA.",
  "",
  "This chatbox uses invite-only access: only people invited by email can open it (workspace membership alone does not grant access). Use it to test tool behavior, regressions, and realistic flows with your MCP servers.",
  "",
  "What to expect:",
  "• Messages and tool usage may be reviewed by your team.",
  "• Connect only servers and data you are allowed to use for internal QA.",
  "• Feedback prompts help you report issues, unexpected tool results, or severity.",
  "",
  "When reporting problems, include what you asked, what you expected, and what happened—especially around tool calls.",
  "",
  "Need access? Ask a teammate who can manage this chatbox to invite your email.",
].join("\n");

const WELCOME_BODY_ICP_DEMO = [
  "Welcome",
  "",
  "This opens with a signed-in link. It is for a quick, safe look at a hosted assistant experience.",
  "",
  "Privacy:",
  "• Do not enter passwords, secrets, or highly sensitive personal data.",
  "• We may ask for brief feedback after some interactions.",
  "• Only share what you are comfortable providing in a demo.",
  "",
  "Thank you for trying it out.",
].join("\n");

/** Prefer a stable default; the first MCPJam model in SUPPORTED_MODELS is often gpt-oss-120b. */
const DEFAULT_HOSTED_CHATBOX_MODEL_ID = "openai/gpt-5-mini";

export function getDefaultHostedModelId(): string {
  if (
    isModelSupported(DEFAULT_HOSTED_CHATBOX_MODEL_ID) &&
    isMCPJamProvidedModel(DEFAULT_HOSTED_CHATBOX_MODEL_ID)
  ) {
    return DEFAULT_HOSTED_CHATBOX_MODEL_ID;
  }
  return (
    SUPPORTED_MODELS.find((model) =>
      isMCPJamProvidedModel(String(model.id)),
    )?.id?.toString() ?? "openai/gpt-5-mini"
  );
}

export const CHATBOX_STARTERS: ChatboxStarterDefinition[] = [
  {
    id: "internal-qa",
    title: "Internal QA",
    description:
      "Invite-only by default. Replay realistic internal flows with your MCP servers.",
    promptHint:
      "QA teammates can use this to verify tool behavior against real company data.",
    templateTooltip:
      "Invite-only (email invites). Tool approval off. Claude-style host. Welcome and feedback tuned for internal QA (prompts after tool-using turns).",
    createDraft: (defaultModelId) => ({
      name: "Internal QA",
      description:
        "Validate production-ready assistant behavior with your internal team.",
      hostStyle: "claude",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      modelId: defaultModelId,
      temperature: TEMPLATE_TEMPERATURE,
      requireToolApproval: false,
      allowGuestAccess: false,
      mode: "invited_only",
      selectedServerIds: [],
      optionalServerIds: [],
      welcomeDialog: { enabled: true, body: WELCOME_BODY_INTERNAL_QA },
      feedbackDialog: {
        enabled: true,
        everyNToolCalls: 1,
        promptHint:
          "Include repro steps, expected vs actual behavior, and severity (blocker vs minor).",
      },
    }),
  },
  {
    id: "icp-demo",
    title: "External Beta Test",
    description: "For prospects and partners who open via signed-in link.",
    promptHint:
      "Use when you want prospects to try your assistant with guided access.",
    templateTooltip:
      "Signed-in link access. Tool approval on. ChatGPT-style host. Welcome and feedback tuned for external testers; lighter feedback cadence.",
    createDraft: (defaultModelId) => ({
      name: "External Beta Test",
      description: "External testing for prospects and design partners.",
      hostStyle: "chatgpt",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      modelId: defaultModelId,
      temperature: TEMPLATE_TEMPERATURE,
      requireToolApproval: true,
      allowGuestAccess: false,
      mode: "any_signed_in_with_link",
      selectedServerIds: [],
      optionalServerIds: [],
      welcomeDialog: { enabled: true, body: WELCOME_BODY_ICP_DEMO },
      feedbackDialog: {
        enabled: true,
        everyNToolCalls: 3,
        promptHint:
          "Short feedback is enough: what worked, what felt confusing, or what you would change.",
      },
    }),
  },
  {
    id: "blank",
    title: "Blank chatbox",
    description: "Start from a clean slate.",
    promptHint:
      "Use this when you want full control over the configuration from the beginning.",
    createDraft: (defaultModelId) => ({
      name: "New Chatbox",
      description: "",
      hostStyle: "claude",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      modelId: defaultModelId,
      temperature: 0.7,
      requireToolApproval: false,
      allowGuestAccess: false,
      mode: "any_signed_in_with_link",
      selectedServerIds: [],
      optionalServerIds: [],
      welcomeDialog: { enabled: true, body: "" },
      feedbackDialog: { enabled: true, everyNToolCalls: 1, promptHint: "" },
    }),
  },
];

/** Primary starter for blank builder draft (first-run “Create New”). */
export const CHATBOX_BLANK_STARTER = CHATBOX_STARTERS.find(
  (s) => s.id === "blank",
)!;

/** Starters shown under “Start from a template” (excludes blank). */
export const CHATBOX_TEMPLATE_STARTERS = CHATBOX_STARTERS.filter(
  (s) => s.id !== "blank",
);

export function toDraftConfig(chatbox: ChatboxSettings): ChatboxDraftConfig {
  return {
    name: chatbox.name,
    description: chatbox.description ?? "",
    hostStyle: chatbox.hostStyle,
    systemPrompt: chatbox.systemPrompt,
    modelId: chatbox.modelId,
    temperature: chatbox.temperature,
    requireToolApproval: chatbox.requireToolApproval,
    allowGuestAccess: chatbox.allowGuestAccess,
    mode: chatbox.mode,
    selectedServerIds: chatbox.servers.map((server) => server.serverId),
    optionalServerIds: chatbox.servers
      .filter((server) => server.optional)
      .map((server) => server.serverId),
    welcomeDialog: {
      enabled: chatbox.welcomeDialog?.enabled ?? true,
      body: chatbox.welcomeDialog?.body ?? "",
    },
    feedbackDialog: {
      enabled: chatbox.feedbackDialog?.enabled ?? true,
      everyNToolCalls: Math.max(
        1,
        chatbox.feedbackDialog?.everyNToolCalls ?? 1,
      ),
      promptHint: chatbox.feedbackDialog?.promptHint ?? "",
    },
  };
}
