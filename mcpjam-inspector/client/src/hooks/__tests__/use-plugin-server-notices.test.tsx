import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivePluginRow } from "@/lib/plugins/active-plugins-types";

const showPluginNotice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/plugins/plugin-notice-display", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/plugins/plugin-notice-display")
  >()),
  showPluginNotice,
}));

import { usePluginServerNotices } from "../use-plugin-server-notices";
import { usePluginServerNoticeStore } from "@/stores/plugin-server-notice-store";

const mail: ActivePluginRow = {
  pluginId: "plg_mail",
  pluginVersionId: "ver_mail",
  name: "mail",
  displayName: "Mail",
  status: "active",
  servers: [
    {
      serverId: "srv_mail",
      name: "inbox",
      componentKey: "inbox",
      placement: "remote",
    },
  ],
  skills: [],
};

const report = (
  chatSessionId: string,
  serverId: string,
  reason: "needs_auth" | "unreachable",
) =>
  act(() => {
    usePluginServerNoticeStore
      .getState()
      .report(chatSessionId, [{ serverId, reason }]);
  });

describe("usePluginServerNotices", () => {
  beforeEach(() => {
    showPluginNotice.mockReset();
    usePluginServerNoticeStore.setState({ reports: {} });
  });

  it("names the plugin a turn ran without a server of, for the chat that turn was in", () => {
    renderHook(() => usePluginServerNotices([mail]));

    report("chat_1", "srv_mail", "needs_auth");

    expect(showPluginNotice).toHaveBeenCalledWith("chat_1", {
      kind: "skipped",
      plugins: [
        {
          pluginId: "plg_mail",
          name: "mail",
          displayName: "Mail",
          reason: "needs_auth",
          partial: true,
        },
      ],
    });
  });

  it("says each report once, and nothing for a server no plugin lists", () => {
    const { rerender } = renderHook(
      ({ plugins }) => usePluginServerNotices(plugins),
      { initialProps: { plugins: [mail] } },
    );

    report("chat_1", "srv_mail", "unreachable");
    rerender({ plugins: [{ ...mail }] });
    report("chat_2", "srv_elsewhere", "unreachable");

    expect(showPluginNotice).toHaveBeenCalledTimes(1);
  });

  it("says a later report for the same chat again", () => {
    renderHook(() => usePluginServerNotices([mail]));

    report("chat_1", "srv_mail", "unreachable");
    report("chat_1", "srv_mail", "needs_auth");

    expect(
      showPluginNotice.mock.calls.map(([, notice]) => notice.plugins[0].reason),
    ).toEqual(["unreachable", "needs_auth"]);
  });
});
