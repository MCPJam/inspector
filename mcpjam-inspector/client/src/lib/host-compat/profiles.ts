import type { HostCompatProfile } from "./types";

/**
 * Per-host compatibility profiles for the L0 prototype.
 *
 * These extend the apps-dimension knowledge in `lib/client-styles/built-ins`
 * with the non-apps dimensions the design doc calls for (transport reach,
 * auth, server-capability surfacing). Like the host-style presets, they are
 * best-effort mocks of what each vendor supports today — every profile
 * carries a `provenance` tag and the UI must keep it visible. Verify against
 * vendor docs before promoting any fact out of "assumed".
 *
 * Apps booleans mirror `built-ins.ts`: claude/cursor render MCP Apps only;
 * chatgpt/copilot render both bridges; codex is a CLI with no widget
 * surface.
 */

export const CLAUDE_COMPAT_PROFILE: HostCompatProfile = {
  id: "claude",
  label: "Claude",
  logoSrc: "/claude_logo.png",
  provenance: "assumed",
  transports: { stdio: true, remoteHttp: true },
  oauth: true,
  serverCapabilities: {
    prompts: true,
    resources: true,
    logging: true,
    completions: false,
  },
  apps: { mcpApps: true, openaiApps: false },
};

export const CHATGPT_COMPAT_PROFILE: HostCompatProfile = {
  id: "chatgpt",
  label: "ChatGPT",
  logoSrc: "/openai_logo.png",
  provenance: "vendor-doc",
  // ChatGPT connectors/apps reach servers over the network only — there is
  // no local stdio path.
  transports: { stdio: false, remoteHttp: true },
  oauth: true,
  serverCapabilities: {
    prompts: false,
    resources: false,
    logging: false,
    completions: false,
  },
  apps: { mcpApps: true, openaiApps: true },
};

export const CURSOR_COMPAT_PROFILE: HostCompatProfile = {
  id: "cursor",
  label: "Cursor",
  logoSrc: "/cursor_logo.png",
  // Apps matrix is probe-captured (Cursor 3.4.17); the non-apps dimensions
  // here are still assumed. Probe wins as the dominant tag because the
  // widget rows are the facts most likely to gate a verdict.
  provenance: "probe",
  transports: { stdio: true, remoteHttp: true },
  oauth: true,
  serverCapabilities: {
    prompts: true,
    resources: true,
    logging: false,
    completions: false,
  },
  apps: { mcpApps: true, openaiApps: false },
};

export const COPILOT_COMPAT_PROFILE: HostCompatProfile = {
  id: "copilot",
  label: "Copilot",
  logoSrc: "/copilot_logo.png",
  // From Microsoft's published "Supported MCP Apps capabilities in Copilot"
  // table (see MCP_APPS_COPILOT_SURFACE in client-styles/built-ins.ts).
  provenance: "vendor-doc",
  transports: { stdio: false, remoteHttp: true },
  oauth: true,
  serverCapabilities: {
    prompts: false,
    resources: false,
    logging: false,
    completions: false,
  },
  apps: { mcpApps: true, openaiApps: true },
};

export const CODEX_COMPAT_PROFILE: HostCompatProfile = {
  id: "codex",
  label: "Codex",
  logoSrc: "/codex-logo.svg",
  provenance: "assumed",
  transports: { stdio: true, remoteHttp: true },
  oauth: true,
  serverCapabilities: {
    prompts: true,
    resources: false,
    logging: false,
    completions: false,
  },
  // CLI surface — no widget rendering of either flavor.
  apps: { mcpApps: false, openaiApps: false },
};

/**
 * The "market view" host list from the design doc: real shipping targets,
 * in the order the strip renders them. MCPJam itself is omitted — it is
 * compatible by construction (it's the surface the developer is already
 * using).
 */
export const HOST_COMPAT_PROFILES: readonly HostCompatProfile[] = [
  CLAUDE_COMPAT_PROFILE,
  CHATGPT_COMPAT_PROFILE,
  CURSOR_COMPAT_PROFILE,
  COPILOT_COMPAT_PROFILE,
  CODEX_COMPAT_PROFILE,
];
