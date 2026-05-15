import type { ComponentType } from "react";
import type {
  McpUiHostCapabilities,
  McpUiStyles,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { UIType } from "@/lib/mcp-ui/mcp-apps-utils";

export type HostStyleId = string;

/**
 * Closed visual rendering family. Drives shared chat-v2 branches that pick
 * between two visual languages (bubble shapes, indicator art, animation
 * timing, etc). New host styles map onto one of these families until the
 * deep UI gains an explicit visual variant of its own.
 */
export type HostStyleFamily = "claude" | "chatgpt";

export type HostThemeMode = "light" | "dark";

/**
 * Wire-bound half of a host style. Everything in here ends up traveling
 * over the MCP Apps `ui/initialize` handshake (capabilities advertise,
 * `hostContext.platform`, `hostContext.styles.variables`, `styles.css.fonts`).
 *
 * Sandbox is intentionally excluded — sandbox CSP/permissions are
 * resource-derived at runtime per SEP-1865, not a static vendor trait.
 */
export interface HostMcpProfile {
  /** MCP-Apps UIType the host emulates inside chat widgets. */
  protocolOverride: UIType;
  /** Platform string passed to the MCP Apps bridge. */
  platform: "web" | "desktop" | "mobile";
  /**
   * `hostCapabilities` blob advertised in the `ui/initialize` response.
   *
   * NOTE: Advertising a capability is a runtime contract. Built-ins should
   * only claim what the renderer actually services so widget authors are
   * not misled when enforcement catches up.
   */
  hostCapabilities: Omit<McpUiHostCapabilities, "sandbox">;
  resolveStyleVariables: (theme: HostThemeMode) => McpUiStyles;
  /** Inline @font-face / @import CSS injected into MCP App iframes. */
  fontCss: string;
}

/**
 * Inspector-side chat chrome for a host style. None of this travels over
 * the MCP wire — it drives the picker, the chat shell background, the
 * loading indicator art, etc.
 *
 * The name `chatUi` deliberately mirrors the backend envelope on
 * `chatboxes.chatUi` (see `mcpjam-backend/convex/lib/chatboxUxValidators.ts`,
 * `chatUiValidator`). Backend stores per-chatbox overrides for this same
 * conceptual category; the client uses the same name for per-host defaults
 * so the vocabulary lines up across the stack. A future per-chatbox
 * indicator override would land as `chatUi.indicator: string` on the
 * chatbox row, mirroring how `chatUi.welcome` works today.
 */
export interface HostChatUi {
  /** Brand label, e.g. "Claude". */
  label: string;
  /** Builder picker copy, e.g. "Claude-style host". */
  shortLabel: string;
  /** One-line description shown beneath the picker label. */
  pickerDescription: string;
  /** Public URL or imported asset for the brand logo. */
  logoSrc: string;
  /** Visual rendering family this host maps onto. */
  family: HostStyleFamily;
  resolveChatBackground: (theme: HostThemeMode) => string;
  /**
   * Brand thinking/loading indicator. Honors `prefers-reduced-motion`
   * internally — the registry contract intentionally does not surface a
   * mode prop so adding a new host stays "register one component."
   */
  loadingIndicator: ComponentType<{ className?: string }>;
}

/**
 * Single source of truth for one host style. Registered in
 * `@/lib/host-styles` and consumed by chatbox bootstrap, builder pickers,
 * shell theming, and the MCP Apps iframe bridge.
 *
 * Adding a new built-in host is a matter of authoring `mcp` + `chatUi`
 * objects and registering them; future project-defined hosts can use the
 * same shape once a scoped host layer exists.
 *
 * Only `id` is persisted to the DB (as `'claude' | 'chatgpt' | 'direct'`
 * on `hostConfigs.hostStyle` / `chatboxes.hostStyle`); both `mcp` and
 * `chatUi` are reconstituted client-side from the id at runtime.
 */
export interface HostStyleDefinition {
  id: HostStyleId;
  mcp: HostMcpProfile;
  chatUi: HostChatUi;
}
