/**
 * Shared edit-vs-add resolution for the auth debuggers' "open the
 * Configure-Server modal" agent commands (oauth-flow today, xaa-flow next).
 *
 * The rule mirrors the registry/hosts groups' no-fuzzy-guess posture: a
 * requested name either IS the selected server (edit), is brand new (add), or
 * names a different existing server — which is rejected rather than silently
 * switched to or overwritten. Pure so the truth table is testable without
 * mounting a tab.
 */

export type AuthConfigModalPlan = { mode: "edit" | "add" } | { reject: string };

export function planAuthConfigModal(input: {
  /** Trimmed serverName from the command payload, if any. */
  requestedServerName?: string;
  /** The tab's selected HTTP server name, or null when none is eligible. */
  selectedServerName: string | null;
  existingServerNames: string[];
}): AuthConfigModalPlan {
  const { requestedServerName, selectedServerName, existingServerNames } =
    input;

  if (!requestedServerName) {
    return { mode: selectedServerName ? "edit" : "add" };
  }
  if (requestedServerName === selectedServerName) {
    return { mode: "edit" };
  }
  if (existingServerNames.includes(requestedServerName)) {
    return {
      reject:
        `A server named "${requestedServerName}" already exists but is not the ` +
        `selected one. Select it with ui_select_server first, or pass a new ` +
        `name to create a new test target.`,
    };
  }
  return { mode: "add" };
}
