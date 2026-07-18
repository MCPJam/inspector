/**
 * The v1 WebMCP UI tool catalog: hand-curated tools that let a chat agent
 * drive the MCPJam inspector. Thin wrappers over the inspector command bus —
 * `navigate`/`selectServer`/`openPlayground` via the hosted-aware actions in
 * `ui-actions.ts`, the playground-scoped commands via
 * `dispatchInspectorCommand` directly (their handlers are registered while
 * the /playground surface is mounted). The mutating playground tools
 * auto-open the playground first when the handler is absent; the read-only
 * `ui_snapshot_app` deliberately does not — it errors instead, so a
 * side-effect-free tool never changes UI state.
 *
 * The definitions live in `groups/` (core / servers / playground); this
 * module is only their composition into the always-on catalog. To add tools
 * for a NEW surface, do not extend this file — build a surface tool group
 * and register it through `useSurfaceAgentBridge`; the full recipe is in
 * `./ADDING_SURFACE_TOOLS.md`.
 *
 * Tool names live in the reserved `ui_` namespace (see
 * `shared/client-fulfilled-tools.ts`) and must satisfy the server-side
 * `validateUiToolEntries` boundary.
 *
 * REGISTRATION POLICY — this catalog is global, deliberately NOT contextual.
 * Chrome's WebMCP guidance suggests registering tools only when useful in
 * the current page state, but that targets content sites where an absent
 * tool is meaningless. Here every catalog tool is reachable from any state
 * via the auto-open fallback, and contextual registration would drop the
 * playground tools from the advertised set whenever the playground is
 * closed — so a one-shot prompt like "open the playground and run X" (the
 * agent panel's core flow) would burn an extra model turn waiting for
 * re-advertisement (`snapshotForChatBody` drains per POST). The policy now
 * has two tiers: this GLOBAL catalog stays registered app-wide for the whole
 * session (`useRegisterUiTools`, scope "global"), while PER-SURFACE groups
 * (`groups/index.ts`) are mount-scoped — registered by
 * `useSurfaceAgentBridge` while their screen is up and unregistered when it
 * leaves (scope "surface"; `shippedNames` makes the mid-session unregister
 * hang-safe, and the App navigate handler waits for a just-mounted group so
 * the same turn can use it).
 */

import type { UiToolDefinition } from "./ui-tools-registry";
import { buildCoreUiTools } from "./groups/core";
import { buildServersUiTools } from "./groups/servers";
import { buildPlaygroundUiTools } from "./groups/playground";

export function buildUiToolsCatalog(): UiToolDefinition[] {
  return [
    ...buildCoreUiTools(),
    ...buildServersUiTools(),
    ...buildPlaygroundUiTools(),
  ];
}
