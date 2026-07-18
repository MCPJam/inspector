/**
 * Kill-switch semantics for the agent-chat flag: unlike the repo's fail-closed
 * pre-launch gates (`=== true`), this hook is deliberately fail-OPEN — the
 * feature is on unless PostHog explicitly returns `false`. The `undefined ⇒
 * true` case is the load-bearing one: it covers the flag-hydration window and
 * a deleted/absent flag, both of which must NOT dark-ship a launched feature.
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

let flagValue: boolean | undefined;
let requestedFlag: string | undefined;

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (flag: string) => {
    requestedFlag = flag;
    return flagValue;
  },
}));

import {
  AGENT_CHAT_FEATURE_FLAG,
  useAgentChatEnabled,
} from "../useAgentChatEnabled";

describe("useAgentChatEnabled", () => {
  it("reads the agent-chat-enabled flag", () => {
    flagValue = undefined;
    renderHook(() => useAgentChatEnabled());
    expect(AGENT_CHAT_FEATURE_FLAG).toBe("agent-chat-enabled");
    expect(requestedFlag).toBe("agent-chat-enabled");
  });

  it("is enabled while the flag is undefined (hydrating or absent)", () => {
    flagValue = undefined;
    const { result } = renderHook(() => useAgentChatEnabled());
    expect(result.current).toBe(true);
  });

  it("is enabled when the flag is true", () => {
    flagValue = true;
    const { result } = renderHook(() => useAgentChatEnabled());
    expect(result.current).toBe(true);
  });

  it("is disabled only on an explicit false (kill switch thrown)", () => {
    flagValue = false;
    const { result } = renderHook(() => useAgentChatEnabled());
    expect(result.current).toBe(false);
  });
});
