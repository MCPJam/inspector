import {
  isMCPJamProvidedModel,
  isModelSupported,
  SUPPORTED_MODELS,
} from "@/shared/types";
import type { ChatboxDraftConfig, ChatboxStarterDefinition } from "./types";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/host-config-v2";

export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

/** Default temperature for template starters (matches blank; personas do not vary temperature). */
const TEMPLATE_TEMPERATURE = 0.7;

/** Canonical URL for the Excalidraw demo MCP server seed. */
export const EXCALIDRAW_MCP_URL = "https://mcp.excalidraw.com/";

const WELCOME_BODY_EXCALIDRAW_DEMO = [
  "Welcome — try the Excalidraw demo.",
  "",
  "This chatbox is pre-wired with the Excalidraw MCP server. Ask the assistant to sketch a diagram, walk through an idea visually, or just play with what the tools can do.",
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
    id: "excalidraw-demo",
    title: "Excalidraw demo",
    description:
      "Try a ready-made chatbox wired to the Excalidraw MCP server.",
    promptHint:
      "Great for sharing a quick demo — ask the assistant to sketch a diagram and watch the tools work.",
    templateTooltip:
      "Link-shareable. Tool approval on. ChatGPT-style host. Pre-attaches the Excalidraw MCP server so the chatbox is usable on first save.",
    serverSeeds: [{ name: "Excalidraw", url: EXCALIDRAW_MCP_URL }],
    createDraft: (defaultModelId) => ({
      name: "Excalidraw demo",
      description: "A demo chatbox powered by the Excalidraw MCP server.",
      hostStyle: "chatgpt",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      modelId: defaultModelId,
      temperature: TEMPLATE_TEMPERATURE,
      requireToolApproval: true,
      allowGuestAccess: false,
      mode: "anyone_with_link",
      selectedServerIds: [],
      optionalServerIds: [],
      chatUi: {
        surfaces: {
          welcome: { enabled: true, body: WELCOME_BODY_EXCALIDRAW_DEMO },
          feedback: {
            enabled: true,
            everyNToolCalls: 3,
            promptHint:
              "Short feedback is enough: what worked, what felt confusing, or what you would change.",
          },
        },
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
      mode: "anyone_with_link",
      selectedServerIds: [],
      optionalServerIds: [],
      chatUi: {
        surfaces: {
          welcome: { enabled: true, body: "" },
          feedback: { enabled: true, everyNToolCalls: 1, promptHint: "" },
        },
      },
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

/**
 * Phase 4: build the v2 hostConfig input for a chatbox save from a
 * draft + project connection seed. The chatbox's `hostConfig` carries
 * its own model/prompt/temperature/host style/server selection;
 * connection settings are seeded from the project default (the editor
 * does not surface them).
 *
 * IMPORTANT: callers MUST pass `projectDefault` whenever the chatbox
 * being minted should inherit the project's connection settings.
 * `mintV2ChatboxHostConfigFromV2Input` on the backend persists the
 * caller-supplied connectionDefaults / clientCapabilities / hostContext
 * verbatim — it does not re-seed from the project default. Calling
 * this helper without `projectDefault` falls back to the v2 empty
 * shapes (empty headers / SDK-default capabilities / empty host
 * context) and will overwrite the project's connection settings on
 * the chatbox row.
 */
export function draftToHostConfigInputV2(
  draft: ChatboxDraftConfig,
  projectDefault?: Pick<
    HostConfigInputV2,
    | "connectionDefaults"
    | "clientCapabilities"
    | "hostContext"
    | "hostCapabilitiesOverride"
    | "chatUiOverride"
    | "mcpProfile"
  > | null,
): HostConfigInputV2 {
  const seed = emptyHostConfigInputV2({
    hostStyle: draft.hostStyle,
    modelId: draft.modelId,
    systemPrompt: draft.systemPrompt,
    temperature: draft.temperature,
    requireToolApproval: draft.requireToolApproval,
    serverIds: draft.selectedServerIds,
    optionalServerIds: draft.optionalServerIds,
    connectionDefaults: projectDefault?.connectionDefaults,
    clientCapabilities: projectDefault?.clientCapabilities,
    hostContext: projectDefault?.hostContext,
    // Inherit the project default's MCP Apps capability override so
    // new/edited chatboxes match what the project-default editor saved.
    // Undefined here keeps "use the active host style preset" intact.
    hostCapabilitiesOverride: projectDefault?.hostCapabilitiesOverride,
    // Inherit the project default's chat-UI override (custom logo,
    // palette, indicator) so new chatboxes pick up the project's
    // BYO host styling. Undefined keeps "use the active host style
    // preset" intact, matching hostCapabilitiesOverride semantics.
    chatUiOverride: projectDefault?.chatUiOverride,
    // Inherit the project default's mcpProfile envelope for the same
    // reason — a new chatbox should connect with the project's pinned
    // clientInfo / supportedProtocolVersions / sandbox policy out of the
    // box. Undefined here keeps "use SDK defaults" intact; the backend
    // hashes that distinctly from `{ profileVersion: 1 }`, so we MUST
    // NOT synthesize an empty envelope.
    mcpProfile: projectDefault?.mcpProfile,
  });
  return seed;
}

/**
 * Phase 4: migrate a sessionStorage builder draft from any older shape
 * into a draft that the current builder can consume. Today the draft
 * still stores flat fields (hostStyle/modelId/etc.) so this is a
 * structural sanity check — fill defaults for anything missing so a
 * draft persisted before required fields were added (e.g. the
 * optionalServerIds split, or the welcome/feedback dialog blocks)
 * doesn't crash the builder. When the draft already carries every
 * required field this is a no-op.
 */
export function migrateBuilderDraft(
  raw: Record<string, unknown> | null | undefined,
): ChatboxDraftConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const blank = CHATBOX_BLANK_STARTER.createDraft(getDefaultHostedModelId());
  const rawChatUi = (raw as { chatUi?: unknown }).chatUi;
  const rawSurfaces =
    rawChatUi && typeof rawChatUi === "object"
      ? ((rawChatUi as { surfaces?: unknown }).surfaces as
          | { welcome?: unknown; feedback?: unknown }
          | undefined)
      : undefined;
  // Pre-chatUi drafts (sessionStorage written before the envelope landed)
  // carry welcome/feedback at the top level. Fall back to them per-surface
  // when the new shape doesn't supply that surface, so an in-flight builder
  // draft doesn't lose its body/cadence the moment we ship.
  const legacyWelcome =
    rawSurfaces?.welcome === undefined
      ? ((raw as { welcomeDialog?: unknown }).welcomeDialog as
          | Partial<ChatboxDraftConfig["chatUi"]["surfaces"]["welcome"]>
          | undefined)
      : undefined;
  const legacyFeedback =
    rawSurfaces?.feedback === undefined
      ? ((raw as { feedbackDialog?: unknown }).feedbackDialog as
          | Partial<ChatboxDraftConfig["chatUi"]["surfaces"]["feedback"]>
          | undefined)
      : undefined;
  // Strip the legacy top-level keys before the spread so the merged draft
  // doesn't carry orphan `welcomeDialog` / `feedbackDialog` properties at
  // runtime alongside the canonical `chatUi`.
  const {
    welcomeDialog: _legacyWelcomeDialog,
    feedbackDialog: _legacyFeedbackDialog,
    ...rawWithoutLegacyKeys
  } = raw as Record<string, unknown>;
  void _legacyWelcomeDialog;
  void _legacyFeedbackDialog;
  const merged: ChatboxDraftConfig = {
    ...blank,
    ...(rawWithoutLegacyKeys as Partial<ChatboxDraftConfig>),
    chatUi: {
      surfaces: {
        welcome: {
          ...blank.chatUi.surfaces.welcome,
          ...(legacyWelcome ?? {}),
          ...((rawSurfaces?.welcome as
            | Partial<ChatboxDraftConfig["chatUi"]["surfaces"]["welcome"]>
            | undefined) ?? {}),
        },
        feedback: {
          ...blank.chatUi.surfaces.feedback,
          ...(legacyFeedback ?? {}),
          ...((rawSurfaces?.feedback as
            | Partial<ChatboxDraftConfig["chatUi"]["surfaces"]["feedback"]>
            | undefined) ?? {}),
        },
      },
    },
    selectedServerIds: Array.isArray(
      (raw as { selectedServerIds?: unknown }).selectedServerIds,
    )
      ? ((raw as { selectedServerIds: string[] }).selectedServerIds.filter(
          (id) => typeof id === "string",
        ) as string[])
      : [],
    optionalServerIds: Array.isArray(
      (raw as { optionalServerIds?: unknown }).optionalServerIds,
    )
      ? ((raw as { optionalServerIds: string[] }).optionalServerIds.filter(
          (id) => typeof id === "string",
        ) as string[])
      : [],
  };
  return merged;
}

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
    chatUi: toChatUiFromChatbox(chatbox),
  };
}

/**
 * Unpacks the chatbox's `chatUi` into the draft shape (defaulting both
 * surfaces). Shared between `toDraftConfig` and the `isDirty` comparator
 * in `ChatboxBuilderView` so both arrive at the same default-coalesced
 * envelope without `isDirty` having to rebuild the entire draft.
 */
export function toChatUiFromChatbox(
  chatbox: ChatboxSettings,
): ChatboxDraftConfig["chatUi"] {
  const welcome = chatbox.chatUi?.surfaces?.welcome;
  const feedback = chatbox.chatUi?.surfaces?.feedback;
  return {
    surfaces: {
      welcome: {
        enabled: welcome?.enabled ?? true,
        body: welcome?.body ?? "",
      },
      feedback: {
        enabled: feedback?.enabled ?? true,
        everyNToolCalls: Math.max(1, feedback?.everyNToolCalls ?? 1),
        promptHint: feedback?.promptHint ?? "",
      },
    },
  };
}
