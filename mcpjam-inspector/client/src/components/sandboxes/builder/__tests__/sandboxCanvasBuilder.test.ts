import { describe, expect, it } from "vitest";
import type { SandboxSettings } from "@/hooks/useSandboxes";
import { buildSandboxCanvas } from "../sandboxCanvasBuilder";
import type { SandboxBuilderContext, SandboxDraftConfig } from "../types";

const baseDraft = (): SandboxDraftConfig => ({
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

function minimalSandbox(overrides: Partial<SandboxSettings> = {}): SandboxSettings {
  return {
    sandboxId: "sb1",
    workspaceId: "ws",
    name: "Saved sandbox",
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

describe("buildSandboxCanvas", () => {
  it("prefers draft server selection over persisted sandbox so canvas matches Setup", () => {
    const draft = baseDraft();
    const sandbox = minimalSandbox();

    const context: SandboxBuilderContext = {
      sandbox,
      draft,
      workspaceServers,
    };

    const vm = buildSandboxCanvas(context);

    const serverNodeIds = vm.nodes
      .filter((n) => n.id.startsWith("server:"))
      .map((n) => n.id);

    expect(serverNodeIds).toEqual(["server:srv-draft"]);
    expect(vm.title).toBe("Draft name");

    const draftNode = vm.nodeMap["server:srv-draft"];
    expect(draftNode?.title).toBe("Draft pick");
  });

  it("falls back to persisted sandbox when draft is absent", () => {
    const sandbox = minimalSandbox();

    const context: SandboxBuilderContext = {
      sandbox,
      draft: null,
      workspaceServers,
    };

    const vm = buildSandboxCanvas(context);

    const serverNodeIds = vm.nodes
      .filter((n) => n.id.startsWith("server:"))
      .map((n) => n.id);

    expect(serverNodeIds).toEqual(["server:srv-saved"]);
    expect(vm.title).toBe("Saved sandbox");
  });
});
