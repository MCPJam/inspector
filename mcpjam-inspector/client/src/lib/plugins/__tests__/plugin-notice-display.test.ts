import { beforeEach, describe, expect, it, vi } from "vitest";

const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({ toast: { info: toastInfo } }));

import { useTrafficLogStore } from "@/stores/traffic-log-store";
import {
  PLUGINS_UNAVAILABLE_MESSAGE,
  describePluginNotice,
  pluginNoticeKey,
  resetShownPluginNotices,
  showPluginNotice,
  type PluginNoticeData,
} from "../plugin-notice-display";

const bitsNeedsAuth: Extract<PluginNoticeData, { kind: "skipped" }> = {
  kind: "skipped",
  plugins: [
    {
      pluginId: "plg_bits",
      name: "bits-and-bolts",
      displayName: "Bits & Bolts",
      reason: "needs_auth",
    },
  ],
};

describe("describePluginNotice", () => {
  it("names the plugin and says what to do, per reason", () => {
    expect(describePluginNotice(bitsNeedsAuth)).toBe(
      "Bits & Bolts was skipped: sign in to its server first.",
    );
    expect(
      describePluginNotice({
        kind: "skipped",
        plugins: [
          {
            pluginId: "plg_bits",
            name: "bits-and-bolts",
            displayName: null,
            reason: "placement",
          },
        ],
      }),
    ).toBe("bits-and-bolts was skipped: its server runs on a local runtime.");
  });

  it("says the chat ran without its plugins when they couldn't be set up", () => {
    expect(describePluginNotice({ kind: "unavailable" })).toBe(
      PLUGINS_UNAVAILABLE_MESSAGE,
    );
  });

  it("says why a message ran without the chat's plugins, without naming environments", () => {
    for (const reason of [
      "local_harness",
      "local_server",
      "local_model",
      "local_tools",
      "compare",
    ] as const) {
      const line = describePluginNotice({ kind: "off", reason });
      expect(line).toMatch(/^Plugins/);
      expect(line).not.toMatch(/environment/i);
    }
    expect(describePluginNotice({ kind: "off", reason: "local_server" })).toBe(
      "Plugins didn't run for this message: a selected server runs on this computer.",
    );
  });

  it("stays one line when several plugins were skipped", () => {
    const line = describePluginNotice({
      kind: "skipped",
      plugins: ["a", "b", "c"].map((id) => ({
        pluginId: id,
        name: id,
        displayName: null,
        reason: "needs_setup" as const,
      })),
    });
    expect(line).toBe(
      "a was skipped: finish its setup first. 2 more plugins were skipped; see Logs for details.",
    );
  });
});

describe("pluginNoticeKey", () => {
  it("ignores the order the plugins arrived in", () => {
    const a = { pluginId: "a", name: "a", displayName: null } as const;
    const b = { pluginId: "b", name: "b", displayName: null } as const;
    expect(
      pluginNoticeKey("chat-1", {
        kind: "skipped",
        plugins: [
          { ...a, reason: "needs_auth" },
          { ...b, reason: "over_cap" },
        ],
      }),
    ).toBe(
      pluginNoticeKey("chat-1", {
        kind: "skipped",
        plugins: [
          { ...b, reason: "over_cap" },
          { ...a, reason: "needs_auth" },
        ],
      }),
    );
  });
});

describe("showPluginNotice", () => {
  beforeEach(() => {
    toastInfo.mockClear();
    resetShownPluginNotices();
    useTrafficLogStore.getState().clear();
  });

  it("shows a notice once per chat and writes one Logs entry", () => {
    expect(showPluginNotice("chat-1", bitsNeedsAuth)).toBe(true);
    expect(showPluginNotice("chat-1", bitsNeedsAuth)).toBe(false);

    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalledWith(
      "Bits & Bolts was skipped: sign in to its server first.",
    );
    const logs = useTrafficLogStore.getState().mcpServerItems;
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      serverId: "plugins",
      serverName: "Plugins",
      method: "plugins/skipped",
      payload: {
        level: "warning",
        message: "Bits & Bolts was skipped: sign in to its server first.",
        plugins: [
          { pluginId: "plg_bits", name: "Bits & Bolts", reason: "needs_auth" },
        ],
      },
    });
  });

  it("shows it again in another chat, or for a different skip", () => {
    showPluginNotice("chat-1", bitsNeedsAuth);
    showPluginNotice("chat-2", bitsNeedsAuth);
    showPluginNotice("chat-1", {
      kind: "skipped",
      plugins: [{ ...bitsNeedsAuth.plugins[0]!, reason: "needs_setup" }],
    });
    expect(toastInfo).toHaveBeenCalledTimes(3);
    expect(useTrafficLogStore.getState().mcpServerItems).toHaveLength(3);
  });

  it("logs an unavailable setup under its own method", () => {
    showPluginNotice("chat-1", { kind: "unavailable" });
    expect(toastInfo).toHaveBeenCalledWith(PLUGINS_UNAVAILABLE_MESSAGE);
    expect(useTrafficLogStore.getState().mcpServerItems[0]?.method).toBe(
      "plugins/unavailable",
    );
  });

  it("logs a message that ran without plugins once per chat and reason", () => {
    expect(
      showPluginNotice("chat-1", { kind: "off", reason: "local_model" }),
    ).toBe(true);
    expect(
      showPluginNotice("chat-1", { kind: "off", reason: "local_model" }),
    ).toBe(false);
    expect(
      showPluginNotice("chat-1", { kind: "off", reason: "local_server" }),
    ).toBe(true);
    const logs = useTrafficLogStore.getState().mcpServerItems;
    expect(logs).toHaveLength(2);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "plugins/off",
          payload: expect.objectContaining({ reason: "local_model" }),
        }),
      ]),
    );
  });

  it("says nothing for an empty skip list", () => {
    expect(showPluginNotice("chat-1", { kind: "skipped", plugins: [] })).toBe(
      false,
    );
    expect(toastInfo).not.toHaveBeenCalled();
  });
});
