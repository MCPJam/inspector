import { useEffect, useRef } from "react";
import type { ActivePluginRow } from "@/lib/plugins/active-plugins-types";
import { unavailableServersForNotice } from "@/lib/plugins/hidden-environment";
import { showPluginNotice } from "@/lib/plugins/plugin-notice-display";
import { usePluginServerNoticeStore } from "@/stores/plugin-server-notice-store";

/**
 * Say which installed plugins a turn ran without one of their servers (see
 * `plugin-server-notice-store.ts`), through the same one-line-per-chat plugin
 * notice and Logs entry as every other plugin notice. Reports are matched to
 * the plugins this Playground read, so the notice names a plugin the way the
 * member knows it; a server none of them lists says nothing.
 */
export function usePluginServerNotices(
  plugins: readonly ActivePluginRow[],
): void {
  const reports = usePluginServerNoticeStore((state) => state.reports);
  // Reports that made a notice. One whose server the plugins read doesn't
  // list yet, during a switch or a recomposition, is checked again when it
  // does.
  const said = useRef(new Set<number>());
  useEffect(() => {
    for (const [chatSessionId, report] of Object.entries(reports)) {
      if (said.current.has(report.seq)) continue;
      const skipped = unavailableServersForNotice(plugins, report.servers);
      if (skipped.length === 0) continue;
      said.current.add(report.seq);
      showPluginNotice(chatSessionId, { kind: "skipped", plugins: skipped });
    }
  }, [reports, plugins]);
}
