import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ onboarding: vi.fn() }));
vi.mock("@/components/host-workspace/thread-app-api", () => ({
  createThreadAppApi: () => api,
}));
vi.mock("@/components/chat-v2/shared/chat-helpers", () => ({
  buildSkillContextMessages: (skills: Array<{ name: string }>) =>
    skills.map((skill) => ({ id: skill.name, role: "user", parts: [] })),
}));

import { pluginOnboardingIntentSchema } from "@/shared/plugin-onboarding";
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
    outgoingSenderMetadata: undefined as Record<string, unknown> | undefined,
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
      metadata: {
        pluginOnboarding: {
          pluginVersionId: "v",
          attemptId: expect.any(String),
        },
      },
    });
  });

  it("names each try, and shows that name in Logs once it was sent", async () => {
    const { useTrafficLogStore } = await import("@/stores/traffic-log-store");
    useTrafficLogStore.getState().clear();
    const surface = deps([{ serverId: "server" }]);
    surface.outgoingSenderMetadata = { senderUserId: "user" };
    const send = createPluginOnboardingSend(surface);
    await send(spec, "server", "t", "owner");
    await send(spec, "server", "t", "owner");
    const attempts = surface.sendMessage.mock.calls.map(
      ([message]) =>
        (message as { metadata: Record<string, unknown> }).metadata,
    );
    expect(attempts[0]).toMatchObject({ senderUserId: "user" });
    const ids = attempts.map(
      (metadata) =>
        (metadata.pluginOnboarding as { attemptId: string }).attemptId,
    );
    expect(
      pluginOnboardingIntentSchema.parse(attempts[1].pluginOnboarding),
    ).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
    const logged = useTrafficLogStore
      .getState()
      .mcpServerItems.filter(
        (item) => item.method === "plugin-extensions/PLUGIN_ONBOARDING_STARTED",
      );
    expect(
      logged.map((item) => (item.payload as { attemptId: string }).attemptId),
    ).toEqual(expect.arrayContaining(ids));
  });

  it("names nothing in Logs for a try that was never sent", async () => {
    const { useTrafficLogStore } = await import("@/stores/traffic-log-store");
    useTrafficLogStore.getState().clear();
    const surface = deps();
    surface.sendMessage.mockResolvedValue(false);
    await expect(
      createPluginOnboardingSend(surface)(
        spec,
        { pluginId: "plugin" },
        "t",
        "owner",
      ),
    ).rejects.toThrow("Onboarding could not start");
    expect(useTrafficLogStore.getState().mcpServerItems).toHaveLength(0);
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
