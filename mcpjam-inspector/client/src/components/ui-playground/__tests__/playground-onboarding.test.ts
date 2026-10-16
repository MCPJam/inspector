import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ onboarding: vi.fn() }));
vi.mock("@/components/host-workspace/thread-app-api", () => ({
  createThreadAppApi: () => api,
}));
vi.mock("@/components/chat-v2/shared/chat-helpers", () => ({
  buildSkillContextMessages: (skills: Array<{ name: string }>) =>
    skills.map((skill) => ({ id: skill.name, role: "user", parts: [] })),
}));

import { createPluginOnboardingSend } from "../playground-onboarding";

const scope = {
  projectId: "p",
  hostId: "h",
  threadId: "t",
  pluginWorkspace: { version: 1 as const, workspaceId: "w" },
};
const spec = {
  pluginId: "plugin",
  pluginVersionId: "v",
  name: "Fixture",
  bundleHash: "hash",
  onboarding: {
    componentId: "c",
    modelRef: "plugin/setup",
    materializedSkillId: "s",
  },
  skill: {
    skillId: "s",
    name: "setup",
    description: "fixture",
    content: "Safe disposable setup",
    contentHash: "content",
  },
  files: [],
};

function deps(servers: Array<{ serverId: string }> = []) {
  return {
    onboardingLiveRef: { current: { ownerKey: "owner", scope, servers } },
    isCompareMode: false,
    sendBlocked: false,
    composerDisabled: false,
    conversationSendBlockedRef: { current: false },
    ensureSelectedServerReadyForChat: vi.fn(async () => true),
    ensureThreadReadyForSend: vi.fn(async () => true),
    ensureLocalHarnessReadyForSend: vi.fn(async () => true),
    setMessages: vi.fn(),
    trackSendMessage: vi.fn(),
    sendMessage: vi.fn(async () => true),
    outgoingSenderMetadata: undefined,
    onFirstMessageSent: vi.fn(),
    extensionThreadTransition: { begin: vi.fn() },
  };
}

describe("the Playground's onboarding send", () => {
  beforeEach(() => {
    api.onboarding.mockReset();
    api.onboarding.mockResolvedValue({ available: true, spec });
  });

  it("sends a plugin's onboarding when the plugin has no server in the chat", async () => {
    const surface = deps();
    await createPluginOnboardingSend(surface)(
      spec,
      { pluginId: "plugin" },
      "t",
      "owner",
    );
    // Read again by plugin before it is sent, never by a server.
    expect(api.onboarding).toHaveBeenCalledWith(
      { pluginId: "plugin" },
      true,
      expect.any(AbortSignal),
    );
    expect(surface.setMessages).toHaveBeenCalledTimes(1);
    expect(surface.sendMessage).toHaveBeenCalledWith({
      text: "Run the attached onboarding skill.",
      metadata: undefined,
    });
  });

  it("refuses a server's onboarding once the server left the chat", async () => {
    const surface = deps([{ serverId: "other" }]);
    await expect(
      createPluginOnboardingSend(surface)(spec, "server", "t", "owner"),
    ).rejects.toThrow("Onboarding is unavailable");
    expect(api.onboarding).not.toHaveBeenCalled();
    expect(surface.sendMessage).not.toHaveBeenCalled();
  });
});
