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
  const seen = useRef(0);
  useEffect(() => {
    let newest = seen.current;
    for (const [chatSessionId, report] of Object.entries(reports)) {
      if (report.seq <= seen.current) continue;
      newest = Math.max(newest, report.seq);
      const skipped = unavailableServersForNotice(plugins, report.servers);
      if (skipped.length > 0) {
        showPluginNotice(chatSessionId, { kind: "skipped", plugins: skipped });
      }
    }
    seen.current = newest;
  }, [reports, plugins]);
}
