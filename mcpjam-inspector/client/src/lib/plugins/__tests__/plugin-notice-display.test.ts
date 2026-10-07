import { beforeEach, describe, expect, it, vi } from "vitest";

const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({ toast: { info: toastInfo } }));

import { useTrafficLogStore } from "@/stores/traffic-log-store";
import type { PluginNoticeData } from "@/shared/plugin-notice";
import {
  PLUGINS_UNAVAILABLE_MESSAGE,
  describePluginNotice,
  pluginNoticeKey,
  resetShownPluginNotices,
  showPluginNotice,
} from "../plugin-notice-display";

const bitsNeedsAuth: PluginNoticeData = {
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

  it("says the read failed when plugins could not load at all", () => {
    expect(describePluginNotice({ kind: "unavailable", plugins: [] })).toBe(
      PLUGINS_UNAVAILABLE_MESSAGE,
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

  it("logs an unavailable read under its own method", () => {
    showPluginNotice("chat-1", { kind: "unavailable", plugins: [] });
    expect(toastInfo).toHaveBeenCalledWith(PLUGINS_UNAVAILABLE_MESSAGE);
    expect(useTrafficLogStore.getState().mcpServerItems[0]?.method).toBe(
      "plugins/unavailable",
    );
  });
});
