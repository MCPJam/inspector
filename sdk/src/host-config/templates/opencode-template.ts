/**
 * OpenCode in a terminal, on the real OpenCode runtime. MCPJam's client runs
 * its MCP tools, as it does Codex's.
 *
 * No handshake of OpenCode's own has been measured, so this pins none: no
 * identity, no protocol, and an empty capability set rather than the SDK
 * default, which would claim MCP Apps. Nothing is advertised to a View
 * either. The other defaults follow the Claude Code and Codex CLI templates.
 * Kept in lockstep with the backend template.
 */
import { emptyHostConfigInputV2 } from "./empty-input.js";
import type { HostTemplate } from "./seed-host-template.js";

export const OPENCODE_TEMPLATE: HostTemplate = {
  id: "opencode",
  label: "OpenCode",
  description: "The OpenCode coding agent in a terminal. No widget rendering.",
  seed: () => {
    const base = emptyHostConfigInputV2({
      hostStyle: "opencode",
      // OpenCode runs Anthropic models through MCPJam's lease. Like the Claude
      // Code template, a hosted Haiku: the one OpenCode's pin is verified on.
      modelId: "anthropic/claude-haiku-4.5",
      temperature: 1.0,
      // New clients ask before a tool runs; saved clients keep theirs.
      requireToolApproval: true,
      // OpenCode does its own discovery; recorded as on, as for Codex CLI.
      progressiveToolDiscovery: true,
      harness: "opencode",
      computer: { kind: "personal" },
      // MCPJam's outer limit, as on the other harness CLI templates.
      connectionDefaults: { headers: {}, requestTimeout: 300_000 },
    });
    base.clientCapabilities = {};
    base.hostCapabilitiesOverride = {};
    base.mcpProfile = { profileVersion: 1 };
    return base;
  },
};
