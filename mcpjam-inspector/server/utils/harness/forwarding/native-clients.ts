/**
 * The handshake each pinned CLI's own MCP client sends, as measured. A
 * runtime's forwarding contract carries its own, and the built-in client
 * template for that CLI pins the same values, so the handshake adds no
 * forwarding gap and a bridged turn still shows the server the CLI's
 * identity. A version bump re-measures it. `template-native-client.test.ts`
 * ties the two together.
 */
import type { NativeClientHandshake } from "./runtime-contract.js";

/**
 * Claude Code 2.1.290. The capabilities are the initialize measured on
 * 2.1.245, which forwarding admits for 2.1.290 (`native-elicitation-profile`);
 * the later catalog probe of 2.1.310 also sent URL elicitation and the Tasks
 * extension. The identity and the accepted protocol versions are that
 * probe's, at the pinned version.
 */
export const CLAUDE_CODE_NATIVE_CLIENT: NativeClientHandshake = {
  clientInfo: {
    name: "claude-code",
    title: "Claude Code",
    version: "2.1.290",
    description: "Anthropic's agentic coding tool",
    websiteUrl: "https://claude.com/claude-code",
  },
  capabilities: { elicitation: { form: {} }, roots: { listChanged: true } },
  supportedProtocolVersions: ["2025-03-26", "2025-06-18", "2025-11-25"],
};

/**
 * Codex 0.163.0. The catalog probe of Codex CLI 0.168.0, at the pinned
 * version: `initialize` at 2025-06-18 and never `server/discover`.
 */
export const CODEX_NATIVE_CLIENT: NativeClientHandshake = {
  clientInfo: { name: "codex-mcp-client", title: "Codex", version: "0.163.0" },
  capabilities: { elicitation: { form: {}, url: {} } },
  supportedProtocolVersions: ["2025-06-18"],
  mcpProtocolVersion: "2025-06-18",
};

/**
 * GitHub Copilot CLI 1.0.92, against a server that refuses `server/discover`:
 * `server/discover` at 2026-07-28 first, as MCPJam's default negotiation
 * does, then `initialize` at 2025-11-25 with this identity and `sampling`.
 */
export const COPILOT_CLI_NATIVE_CLIENT: NativeClientHandshake = {
  clientInfo: { name: "copilot-cli", version: "1.0.92" },
  capabilities: { sampling: {} },
};

/**
 * Cursor CLI 2026.11.05-86047df: `initialize` at 2025-11-25 first, and
 * `server/discover` at 2026-07-28 only after a `-32022` refusal naming it.
 * Form elicitation, which it declines itself. It also declares the MCP Apps
 * extension, though it renders no View; a client profile that declared it
 * would have MCPJam render Views this CLI never shows, so it is left out.
 */
export const CURSOR_CLI_NATIVE_CLIENT: NativeClientHandshake = {
  clientInfo: { name: "Cursor", version: "1.0.0" },
  capabilities: { elicitation: { form: {} } },
  versionNegotiation: "legacy-first",
};
