import type {
  ActivePluginRow,
  ActivePluginSkipReason,
} from "@/lib/plugins/active-plugins-types";
import type { PluginComponentReadiness } from "@/lib/plugins/plugin-api-types";

/**
 * What a plugin's servers say where a project server's connect switch sits.
 *
 * Plugin servers are not browser connections: the chat route connects them
 * on every message. So instead of a switch, the card states whether normal
 * chats run the plugin right now (`plugins:resolveActivePlugins`), and if not,
 * why.
 */
export interface PluginStatusPresentation {
  label: string;
  tone: "active" | "attention" | "muted";
}

const SKIP_LABELS: Record<string, string> = {
  not_ready: "version not ready",
  no_active_version: "no active version",
  over_cap: "over the 10-plugin limit",
  server_missing: "server missing",
  placement: "can't run here",
  skill_unpinnable: "a skill can't load",
};

export function describeSkipReason(reason: ActivePluginSkipReason): string {
  return SKIP_LABELS[reason] ?? String(reason).replace(/_/g, " ");
}

/**
 * The status of one installed plugin.
 *
 * `row` is the plugin's row from `useActivePlugins`, when the backend has
 * answered. Without one (still loading, or a backend that predates the read)
 * the component's own setup readiness is the best thing to say, and nothing
 * claims "Active".
 */
export function describePluginStatus(input: {
  enabled: boolean;
  activeVersionId: string | null | undefined;
  row?: Pick<ActivePluginRow, "status" | "reason"> | null;
  readiness?: PluginComponentReadiness;
}): PluginStatusPresentation {
  if (!input.enabled || input.row?.reason === "disabled") {
    return { label: "Disabled", tone: "muted" };
  }
  if (input.row?.status === "active") {
    return { label: "Active", tone: "active" };
  }
  const reason = input.row?.status === "skipped" ? input.row.reason : undefined;
  if (
    reason === "needs_auth" ||
    (!reason && input.readiness === "needs_auth")
  ) {
    return { label: "Needs sign-in", tone: "attention" };
  }
  if (
    reason === "needs_setup" ||
    (!reason && input.readiness === "needs_setup")
  ) {
    return { label: "Needs setup", tone: "attention" };
  }
  if (reason) {
    return {
      label: `Skipped: ${describeSkipReason(reason)}`,
      tone: "attention",
    };
  }
  if (!input.activeVersionId) {
    return { label: "No active version", tone: "muted" };
  }
  if (input.readiness === "ready") return { label: "Ready", tone: "muted" };
  return { label: "Installed", tone: "muted" };
}

/** The status dot's role-token class for a tone. */
export function pluginStatusDotClass(
  tone: PluginStatusPresentation["tone"],
): string {
  switch (tone) {
    case "active":
      return "bg-success";
    case "attention":
      return "bg-warning";
    case "muted":
      return "bg-muted-foreground";
  }
}

/** Plugin lifecycle (activate, enable/disable, uninstall) is project-admin only. */
export const PLUGIN_ADMIN_ONLY_REASON =
  "Only project admins can activate, disable or uninstall plugins.";

/** Detaching a plugin skill as a copy is project-admin only too. */
export const PLUGIN_DETACH_ADMIN_ONLY_REASON =
  "Only project admins can detach plugin skills.";
