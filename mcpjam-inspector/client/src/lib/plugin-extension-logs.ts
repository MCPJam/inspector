import { useTrafficLogStore } from "@/stores/traffic-log-store";

/**
 * Write an OpenAI plugin extension problem to the Playground's Logs panel.
 *
 * Plugin extensions never get diagnostic UI of their own: when something
 * can't work, the surface shows a plain-English description and the details
 * land here. `dedupeKey` makes repeats (a hook re-rendering, a retry)
 * update one row instead of flooding the panel.
 */
export function logPluginExtensionIssue(input: {
  code: string;
  message: string;
  level?: "error" | "warning" | "info";
  serverId?: string;
  serverName?: string;
  detail?: Record<string, unknown>;
  dedupeKey?: string;
}): void {
  try {
    useTrafficLogStore.getState().addMcpServerLog({
      ...(input.dedupeKey
        ? { id: `plugin-extensions:${input.dedupeKey}` }
        : {}),
      serverId: input.serverId ?? "plugin-extensions",
      serverName: input.serverName ?? "Plugin extensions",
      direction: "RECEIVE",
      method: `plugin-extensions/${input.code}`,
      timestamp: new Date().toISOString(),
      payload: {
        level: input.level ?? "error",
        code: input.code,
        message: input.message,
        ...(input.detail ?? {}),
      },
    });
  } catch {
    // Logging must never break the surface that hit the problem.
  }
}
