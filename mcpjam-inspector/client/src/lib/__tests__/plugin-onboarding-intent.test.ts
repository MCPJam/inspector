import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({ toast: { error: toastError } }));

import {
  PLUGIN_ONBOARDING_INTENT_TTL_MS,
  PLUGIN_ONBOARDING_RESUME_TTL_MS,
  cancelOnboardingAfterSignIn,
  hasOnboardingAfterSignIn,
  markOnboardingSignInCompleted,
  requestOnboardingAfterSignIn,
  resumeOnboardingAfterSignIn,
  usePluginOnboardingIntentStore,
} from "@/lib/plugin-onboarding-intent";
import type { ActivePluginRow } from "@/lib/plugins/active-plugins-types";
import { useTrafficLogStore } from "@/stores/traffic-log-store";

const request = (serverIds = ["srv"]) =>
  usePluginOnboardingIntentStore.getState().request({
    projectId: "p",
    serverIds,
    pluginId: "plg",
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

  it("points a plugin with no server to its settings when it expires", () => {
    request([]);
    vi.advanceTimersByTime(PLUGIN_ONBOARDING_INTENT_TTL_MS + 1);
    expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(/Set up from the plugin's settings/),
    );
    expect(toastError).not.toHaveBeenCalledWith(
      expect.stringMatching(/server/),
    );
  });

  it("does not report expiry once taken", () => {
    const intent = request();
    usePluginOnboardingIntentStore.getState().take(intent.id);
    vi.advanceTimersByTime(PLUGIN_ONBOARDING_INTENT_TTL_MS + 1);
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("a Set up that signs in first", () => {
  const kept = {
    projectId: "p",
    serverIds: ["srv"],
    pluginId: "plg",
    pluginName: "Bits & Bolts",
    conversation: "new" as const,
  };
  const binding = { pluginVersionId: "pv", componentKey: "server:api" };
  const plugins = (unavailable?: "needs_auth"): ActivePluginRow[] => [
    {
      pluginId: "plg",
      pluginVersionId: "pv",
      name: "bits",
      displayName: "Bits & Bolts",
      status: "active",
      servers: [
        {
          serverId: "srv",
          name: "api",
          componentKey: "server:api",
          placement: "remote",
          ...(unavailable ? { unavailable } : {}),
        },
      ],
      skills: [],
    },
  ];
  beforeEach(() => {
    sessionStorage.clear();
    usePluginOnboardingIntentStore.getState().clear();
  });

  it("is made, once, when this tab's sign-in finished and its server reads usable", () => {
    requestOnboardingAfterSignIn(kept, binding, 1_000);
    markOnboardingSignInCompleted(binding, 1_500);
    expect(hasOnboardingAfterSignIn("p")).toBe(true);
    resumeOnboardingAfterSignIn("elsewhere", plugins(), 2_000);
    expect(hasOnboardingAfterSignIn("p")).toBe(true);

    resumeOnboardingAfterSignIn("p", plugins(), 3_000);
    expect(usePluginOnboardingIntentStore.getState().intent).toMatchObject(
      kept,
    );
    expect(hasOnboardingAfterSignIn("p")).toBe(false);
    usePluginOnboardingIntentStore.getState().clear();
    resumeOnboardingAfterSignIn("p", plugins(), 4_000);
    expect(usePluginOnboardingIntentStore.getState().intent).toBeNull();
  });

  it.each([
    ["still needs the sign-in", plugins("needs_auth")],
    ["no longer lists the plugin", []],
  ])(
    "is dropped by a read that %s, so a later sign-in starts nothing",
    (_, read) => {
      requestOnboardingAfterSignIn(kept, binding, 1_000);
      markOnboardingSignInCompleted(binding, 1_500);
      resumeOnboardingAfterSignIn("p", read, 2_000);
      expect(hasOnboardingAfterSignIn("p")).toBe(false);
      resumeOnboardingAfterSignIn("p", plugins(), 3_000);
      expect(usePluginOnboardingIntentStore.getState().intent).toBeNull();
      expect(toastError).not.toHaveBeenCalled();
    },
  );

  it("waits a full lifetime from a sign-in that finished near the end of its own", () => {
    requestOnboardingAfterSignIn(kept, binding, 1_000);
    markOnboardingSignInCompleted(binding, PLUGIN_ONBOARDING_RESUME_TTL_MS);
    resumeOnboardingAfterSignIn(
      "p",
      plugins(),
      PLUGIN_ONBOARDING_RESUME_TTL_MS + 5_000,
    );
    expect(usePluginOnboardingIntentStore.getState().intent).toMatchObject(
      kept,
    );
  });

  it("lapses quietly when the read comes a lifetime after the sign-in finished", () => {
    requestOnboardingAfterSignIn(kept, binding, 1_000);
    markOnboardingSignInCompleted(binding, 1_500);
    resumeOnboardingAfterSignIn(
      "p",
      plugins(),
      1_500 + PLUGIN_ONBOARDING_RESUME_TTL_MS + 1,
    );
    expect(hasOnboardingAfterSignIn("p")).toBe(false);
    expect(usePluginOnboardingIntentStore.getState().intent).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  it.each([
    ["no sign-in finished in this tab", undefined],
    [
      "this tab finished another server's sign-in",
      { pluginVersionId: "pv", componentKey: "server:other" },
    ],
  ])("is dropped, though its server reads usable, when %s", (_, finished) => {
    requestOnboardingAfterSignIn(kept, binding, 1_000);
    markOnboardingSignInCompleted(finished, 1_500);
    resumeOnboardingAfterSignIn("p", plugins(), 2_000);
    expect(usePluginOnboardingIntentStore.getState().intent).toBeNull();
    expect(hasOnboardingAfterSignIn("p")).toBe(false);
  });

  it("is dropped when it is cancelled or unreadable", () => {
    requestOnboardingAfterSignIn(kept, binding, 1_000);
    cancelOnboardingAfterSignIn();
    resumeOnboardingAfterSignIn("p", plugins(), 2_000);
    expect(usePluginOnboardingIntentStore.getState().intent).toBeNull();

    sessionStorage.setItem("mcp-plugin-onboarding-resume", "{not json");
    resumeOnboardingAfterSignIn("p", plugins(), 2_000);
    expect(usePluginOnboardingIntentStore.getState().intent).toBeNull();
  });

  it("does not throw when this browser refuses storage", () => {
    const refuse = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(refuse);
    const removeItem = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(refuse);
    expect(() => requestOnboardingAfterSignIn(kept, binding)).not.toThrow();
    expect(() => cancelOnboardingAfterSignIn()).not.toThrow();
    setItem.mockRestore();
    removeItem.mockRestore();
  });
});
