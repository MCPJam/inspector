import { describe, expect, it } from "vitest";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import { buildChatboxCanvas } from "../chatboxCanvasBuilder";
import type { ChatboxBuilderContext, ChatboxDraftConfig } from "../types";

const baseDraft = (): ChatboxDraftConfig => ({
  name: "Draft name",
  description: "",
  hostStyle: "claude",
  systemPrompt: "x",
  modelId: "openai/gpt-5-mini",
  temperature: 0.7,
  requireToolApproval: false,
  allowGuestAccess: false,
  mode: "any_signed_in_with_link",
  selectedServerIds: ["srv-draft"],
  optionalServerIds: [],
  welcomeDialog: { enabled: true, body: "" },
  feedbackDialog: { enabled: true, everyNToolCalls: 1, promptHint: "" },
});

const workspaceServers = [
  {
    _id: "srv-saved",
    workspaceId: "ws",
    name: "Saved only",
    enabled: true,
    transportType: "http" as const,
    url: "https://saved.example/mcp",
    useOAuth: false,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    _id: "srv-draft",
    workspaceId: "ws",
    name: "Draft pick",
    enabled: true,
    transportType: "http" as const,
    url: "https://draft.example/mcp",
    useOAuth: false,
    createdAt: 1,
    updatedAt: 1,
  },
];

function minimalChatbox(
  overrides: Partial<ChatboxSettings> = {},
): ChatboxSettings {
  return {
    chatboxId: "sb1",
    workspaceId: "ws",
    name: "Saved chatbox",
    description: "",
    hostStyle: "claude",
    systemPrompt: "x",
    modelId: "openai/gpt-5-mini",
    temperature: 0.7,
    requireToolApproval: false,
    allowGuestAccess: false,
    mode: "any_signed_in_with_link",
    servers: [
      {
        serverId: "srv-saved",
        serverName: "Saved only",
        useOAuth: false,
        serverUrl: "https://saved.example/mcp",
        clientId: null,
        oauthScopes: null,
      },
    ],
    link: null,
    members: [],
    ...overrides,
  };
}

describe("buildChatboxCanvas", () => {
  it("prefers draft server selection over persisted chatbox so canvas matches Setup", () => {
    const draft = baseDraft();
    const chatbox = minimalChatbox();

    const context: ChatboxBuilderContext = {
      chatbox,
      draft,
      workspaceServers,
    };

    const vm = buildChatboxCanvas(context);

    const serverNodeIds = vm.nodes
      .filter((n) => n.id.startsWith("server:"))
      .map((n) => n.id);

    expect(serverNodeIds).toEqual(["server:srv-draft"]);
    expect(vm.title).toBe("Draft name");

    const draftNode = vm.nodeMap["server:srv-draft"];
    expect(draftNode?.title).toBe("Draft pick");
  });

  it("falls back to persisted chatbox when draft is absent", () => {
    const chatbox = minimalChatbox();

    const context: ChatboxBuilderContext = {
      chatbox,
      draft: null,
      workspaceServers,
    };

    const vm = buildChatboxCanvas(context);

    const serverNodeIds = vm.nodes
      .filter((n) => n.id.startsWith("server:"))
      .map((n) => n.id);

    expect(serverNodeIds).toEqual(["server:srv-saved"]);
    expect(vm.title).toBe("Saved chatbox");
  });
});
