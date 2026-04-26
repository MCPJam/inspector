import type { McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";
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
 * Single source of truth for one host style. Registered in
 * `@/lib/host-styles` and consumed by chatbox bootstrap, builder pickers,
 * shell theming, and the MCP Apps iframe bridge.
 *
 * Adding a new built-in host is a matter of authoring one of these objects
 * and registering it; workspace-defined custom hosts may be passed at
 * lookup time without mutating the global registry.
 */
export interface HostStyleDefinition {
  id: HostStyleId;
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
  /** MCP-Apps UIType the host emulates inside chat widgets. */
  protocolOverride: UIType;
  /** Platform string passed to the MCP Apps bridge. */
  platform: "web" | "desktop" | "mobile";
  /** Inline @font-face CSS injected into MCP App iframes. */
  fontCss: string;
  resolveStyleVariables: (theme: HostThemeMode) => McpUiStyles;
  resolveChatBackground: (theme: HostThemeMode) => string;
}
