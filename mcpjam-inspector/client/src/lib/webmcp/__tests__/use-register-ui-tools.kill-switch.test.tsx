/**
 * Flag matrix for the App.tsx registration gate
 * `useRegisterUiTools({ enabled: !isChatboxChatRoute && agentChatEnabled })`:
 * the composed condition is reproduced here (App-level rendering is
 * impractical) so the kill switch provably empties the ui_* catalog, the
 * fail-open hydration window provably does NOT, and the chatbox-route guard
 * wins regardless of the flag.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/webmcp/native-mirror", () => ({
  mirrorUiToolToNative: vi.fn(() => null),
}));

let agentChatFlag: boolean | undefined;

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (flag: string) =>
    flag === "agent-chat-enabled" ? agentChatFlag : undefined,
}));

import { useRegisterUiTools } from "../use-register-ui-tools";
import { useUiToolsRegistry } from "../ui-tools-registry";
import { useAgentChatEnabled } from "@/hooks/useAgentChatEnabled";

// Mirrors the App.tsx call site's composed condition.
function useAppRegistrationGate({
  isChatboxChatRoute,
}: {
  isChatboxChatRoute: boolean;
}) {
  const agentChatEnabled = useAgentChatEnabled();
  useRegisterUiTools({ enabled: !isChatboxChatRoute && agentChatEnabled });
}

const registrySize = () => useUiToolsRegistry.getState().tools.size;

describe("useRegisterUiTools agent-chat kill switch", () => {
  beforeEach(() => {
    agentChatFlag = undefined;
    useUiToolsRegistry.setState({
      tools: new Map(),
      nativeDisposers: new Map(),
      shippedNames: new Set(),
    });
  });

  it("registers while the flag is undefined (fail-open hydration window)", () => {
    const { unmount } = renderHook(() =>
      useAppRegistrationGate({ isChatboxChatRoute: false })
    );
    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).not.toBeNull();
    unmount();
    expect(registrySize()).toBe(0);
  });

  it("registers nothing when the flag is false, and follows flag flips", () => {
    agentChatFlag = false;
    const { rerender, unmount } = renderHook(() =>
      useAppRegistrationGate({ isChatboxChatRoute: false })
    );
    expect(registrySize()).toBe(0);

    agentChatFlag = true;
    rerender();
    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).not.toBeNull();

    agentChatFlag = false;
    rerender();
    expect(registrySize()).toBe(0);
    unmount();
  });

  it("keeps the chatbox-route guard regardless of the flag", () => {
    agentChatFlag = true;
    const { unmount } = renderHook(() =>
      useAppRegistrationGate({ isChatboxChatRoute: true })
    );
    expect(registrySize()).toBe(0);
    unmount();
  });
});
