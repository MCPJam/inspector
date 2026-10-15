import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({ toast: { error: toastError } }));

import {
  PLUGIN_ONBOARDING_INTENT_TTL_MS,
  usePluginOnboardingIntentStore,
} from "@/lib/plugin-onboarding-intent";
import { useTrafficLogStore } from "@/stores/traffic-log-store";

const request = () =>
  usePluginOnboardingIntentStore.getState().request({
    projectId: "p",
    serverIds: ["srv"],
    pluginName: "Bits & Bolts",
    conversation: "new",
  });

describe("plugin onboarding intent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    usePluginOnboardingIntentStore.getState().clear();
    useTrafficLogStore.getState().clear();
    toastError.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("is taken exactly once", () => {
    const intent = request();
    expect(usePluginOnboardingIntentStore.getState().take(intent.id)).toEqual(
      intent,
    );
    expect(usePluginOnboardingIntentStore.getState().take(intent.id)).toBeNull();
  });

  it("a newer request replaces an older one", () => {
    const first = request();
    const second = request();
    expect(usePluginOnboardingIntentStore.getState().take(first.id)).toBeNull();
    expect(usePluginOnboardingIntentStore.getState().take(second.id)?.id).toBe(
      second.id,
    );
  });

  it("expires with a described error instead of running late", () => {
    const intent = request();
    vi.advanceTimersByTime(PLUGIN_ONBOARDING_INTENT_TTL_MS + 1);
    expect(usePluginOnboardingIntentStore.getState().intent).toBeNull();
    expect(usePluginOnboardingIntentStore.getState().take(intent.id)).toBeNull();
    expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(/Couldn't start Bits & Bolts setup/),
    );
    expect(
      useTrafficLogStore
        .getState()
        .mcpServerItems.some(
          (item) =>
            item.method === "plugin-extensions/PLUGIN_ONBOARDING_NOT_STARTED",
        ),
    ).toBe(true);
  });

  it("does not report expiry once taken", () => {
    const intent = request();
    usePluginOnboardingIntentStore.getState().take(intent.id);
    vi.advanceTimersByTime(PLUGIN_ONBOARDING_INTENT_TTL_MS + 1);
    expect(toastError).not.toHaveBeenCalled();
  });
});
