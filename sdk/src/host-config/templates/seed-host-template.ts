/**
 * Node-safe host-template seeds for built-in MCPJam host presets.
 *
 * GENERATED-FROM (verbatim port): inspector client
 * `client/src/lib/client-templates.ts`. Moved into the SDK so the server's
 * `--template` resolver and the CLI can seed a host config in Node without
 * importing browser-only client code. The client re-exports `seedHostTemplate`
 * from here (delegating its UI templates) so the seed logic has one source of
 * truth; UI-only metadata (logos) stays client-side.
 *
 * Two deliberate edits vs the client source: the Vite `__APP_VERSION__`
 * constant is parametrized as `opts.appVersion`, and the UI `logoSrc` metadata
 * is dropped. A parity test asserts byte-identical output vs the client seeds.
 */

import {
  emptyHostConfigInputV2,
  type SeededHostConfigInput,
} from "./empty-input.js";
import {
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
} from "../../mcp-client-manager/capabilities.js";
import {
  MCPJAM_FONT_CSS,
  MCPJAM_PLATFORM,
  getMcpJamStyleVariables,
} from "./mcpjam-style.js";
import { getMistralStyleVariables } from "./mistral-style.js";
import {
  GOOSE_FONT_CSS,
  GOOSE_HOST_STYLE_VARIABLES,
  GOOSE_PLATFORM,
} from "./goose-style.js";
import { SLACK_FONT_CSS, getSlackStyleVariables } from "./slack-style.js";

type HostThemeMode = "light" | "dark";

/** Fallback when no appVersion is provided (only the mcpjam template reads it). */
const DEFAULT_SEED_APP_VERSION = "0.0.0";

// Verbatim from a real claude.ai ui/initialize response. Kept out of the
// template entry for readability. Updating these keeps the Claude template
// in lockstep with what real claude.ai publishes to MCP App views.
const CLAUDE_HOST_STYLE_VARIABLES: Record<string, string> = {
  "--color-background-primary":
    "light-dark(rgba(255, 255, 255, 1), rgba(48, 48, 46, 1))",
  "--color-background-secondary":
    "light-dark(rgba(245, 244, 237, 1), rgba(38, 38, 36, 1))",
  "--color-background-tertiary":
    "light-dark(rgba(250, 249, 245, 1), rgba(20, 20, 19, 1))",
  "--color-background-inverse":
    "light-dark(rgba(20, 20, 19, 1), rgba(250, 249, 245, 1))",
  "--color-background-ghost":
    "light-dark(rgba(255, 255, 255, 0), rgba(48, 48, 46, 0))",
  "--color-background-info":
    "light-dark(rgba(214, 228, 246, 1), rgba(37, 62, 95, 1))",
  "--color-background-danger":
    "light-dark(rgba(247, 236, 236, 1), rgba(96, 42, 40, 1))",
  "--color-background-success":
    "light-dark(rgba(233, 241, 220, 1), rgba(27, 70, 20, 1))",
  "--color-background-warning":
    "light-dark(rgba(246, 238, 223, 1), rgba(72, 58, 15, 1))",
  "--color-background-disabled":
    "light-dark(rgba(255, 255, 255, 0.5), rgba(48, 48, 46, 0.5))",
  "--color-text-primary":
    "light-dark(rgba(20, 20, 19, 1), rgba(250, 249, 245, 1))",
  "--color-text-secondary":
    "light-dark(rgba(61, 61, 58, 1), rgba(194, 192, 182, 1))",
  "--color-text-tertiary":
    "light-dark(rgba(115, 114, 108, 1), rgba(156, 154, 146, 1))",
  "--color-text-inverse":
    "light-dark(rgba(255, 255, 255, 1), rgba(20, 20, 19, 1))",
  "--color-text-ghost":
    "light-dark(rgba(115, 114, 108, 0.5), rgba(156, 154, 146, 0.5))",
  "--color-text-info":
    "light-dark(rgba(50, 102, 173, 1), rgba(128, 170, 221, 1))",
  "--color-text-danger":
    "light-dark(rgba(127, 44, 40, 1), rgba(238, 136, 132, 1))",
  "--color-text-success":
    "light-dark(rgba(38, 91, 25, 1), rgba(122, 185, 72, 1))",
  "--color-text-warning":
    "light-dark(rgba(90, 72, 21, 1), rgba(209, 160, 65, 1))",
  "--color-text-disabled":
    "light-dark(rgba(20, 20, 19, 0.5), rgba(250, 249, 245, 0.5))",
  "--color-border-primary":
    "light-dark(rgba(31, 30, 29, 0.4), rgba(222, 220, 209, 0.4))",
  "--color-border-secondary":
    "light-dark(rgba(31, 30, 29, 0.3), rgba(222, 220, 209, 0.3))",
  "--color-border-tertiary":
    "light-dark(rgba(31, 30, 29, 0.15), rgba(222, 220, 209, 0.15))",
  "--color-border-inverse":
    "light-dark(rgba(255, 255, 255, 0.3), rgba(20, 20, 19, 0.15))",
  "--color-border-ghost":
    "light-dark(rgba(31, 30, 29, 0), rgba(222, 220, 209, 0))",
  "--color-border-info":
    "light-dark(rgba(70, 130, 213, 1), rgba(70, 130, 213, 1))",
  "--color-border-danger":
    "light-dark(rgba(167, 61, 57, 1), rgba(205, 92, 88, 1))",
  "--color-border-success":
    "light-dark(rgba(67, 116, 38, 1), rgba(89, 145, 48, 1))",
  "--color-border-warning":
    "light-dark(rgba(128, 92, 31, 1), rgba(168, 120, 41, 1))",
  "--color-border-disabled":
    "light-dark(rgba(31, 30, 29, 0.1), rgba(222, 220, 209, 0.1))",
  "--color-ring-primary":
    "light-dark(rgba(20, 20, 19, 0.7), rgba(250, 249, 245, 0.7))",
  "--color-ring-secondary":
    "light-dark(rgba(61, 61, 58, 0.7), rgba(194, 192, 182, 0.7))",
  "--color-ring-inverse":
    "light-dark(rgba(255, 255, 255, 0.7), rgba(20, 20, 19, 0.7))",
  "--color-ring-info":
    "light-dark(rgba(50, 102, 173, 0.5), rgba(128, 170, 221, 0.5))",
  "--color-ring-danger":
    "light-dark(rgba(167, 61, 57, 0.5), rgba(205, 92, 88, 0.5))",
  "--color-ring-success":
    "light-dark(rgba(67, 116, 38, 0.5), rgba(89, 145, 48, 0.5))",
  "--color-ring-warning":
    "light-dark(rgba(128, 92, 31, 0.5), rgba(168, 120, 41, 0.5))",
  "--font-sans": "Anthropic Sans, sans-serif",
  "--font-mono": "ui-monospace, monospace",
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
  "--font-text-xs-size": "12px",
  "--font-text-sm-size": "14px",
  "--font-text-md-size": "16px",
  "--font-text-lg-size": "20px",
  "--font-heading-xs-size": "12px",
  "--font-heading-sm-size": "14px",
  "--font-heading-md-size": "16px",
  "--font-heading-lg-size": "20px",
  "--font-heading-xl-size": "24px",
  "--font-heading-2xl-size": "28px",
  "--font-heading-3xl-size": "36px",
  "--font-text-xs-line-height": "1.4",
  "--font-text-sm-line-height": "1.4",
  "--font-text-md-line-height": "1.4",
  "--font-text-lg-line-height": "1.25",
  "--font-heading-xs-line-height": "1.4",
  "--font-heading-sm-line-height": "1.4",
  "--font-heading-md-line-height": "1.4",
  "--font-heading-lg-line-height": "1.25",
  "--font-heading-xl-line-height": "1.25",
  "--font-heading-2xl-line-height": "1.1",
  "--font-heading-3xl-line-height": "1",
  "--border-radius-xs": "4px",
  "--border-radius-sm": "6px",
  "--border-radius-md": "8px",
  "--border-radius-lg": "10px",
  "--border-radius-xl": "12px",
  "--border-radius-full": "9999px",
  "--border-width-regular": "0.5px",
  "--shadow-hairline": "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
  "--shadow-sm":
    "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)",
  "--shadow-md":
    "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)",
  "--shadow-lg":
    "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)",
};

// @font-face block claude.ai injects via hostContext.styles.css.fonts.
// Templates use `apps.sandbox.csp.mode: "declared"`, so font URLs load
// based on the resource's own `_meta.ui.csp` (font-src) declaration —
// no per-domain allowlist is set on the template. If a host operator
// wants to clamp font origins they should union assets.claude.ai into
// a renderer-layer baseline rather than re-introducing a `restrictTo`
// here (which intersects, not unions, and silently zeros out widgets).
const CLAUDE_FONTS_CSS = `
@font-face {
  font-family: "Anthropic Sans";
  src: url("https://assets.claude.ai/Fonts/AnthropicSans-Text-Regular-Static.otf") format("opentype");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Anthropic Sans";
  src: url("https://assets.claude.ai/Fonts/AnthropicSans-Text-RegularItalic-Static.otf") format("opentype");
  font-weight: 400;
  font-style: italic;
  font-display: swap;
}
@font-face {
  font-family: "Anthropic Sans";
  src: url("https://assets.claude.ai/Fonts/AnthropicSans-Text-Medium-Static.otf") format("opentype");
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Anthropic Sans";
  src: url("https://assets.claude.ai/Fonts/AnthropicSans-Text-MediumItalic-Static.otf") format("opentype");
  font-weight: 500;
  font-style: italic;
  font-display: swap;
}
@font-face {
  font-family: "Anthropic Sans";
  src: url("https://assets.claude.ai/Fonts/AnthropicSans-Text-Semibold-Static.otf") format("opentype");
  font-weight: 600;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Anthropic Sans";
  src: url("https://assets.claude.ai/Fonts/AnthropicSans-Text-SemiboldItalic-Static.otf") format("opentype");
  font-weight: 600;
  font-style: italic;
  font-display: swap;
}
@font-face {
  font-family: "Anthropic Sans";
  src: url("https://assets.claude.ai/Fonts/AnthropicSans-Text-Bold-Static.otf") format("opentype");
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Anthropic Sans";
  src: url("https://assets.claude.ai/Fonts/AnthropicSans-Text-BoldItalic-Static.otf") format("opentype");
  font-weight: 700;
  font-style: italic;
  font-display: swap;
}
`;

/**
 * Canonical list of built-in host-template ids — the single source of truth
 * reused by the SDK platform `create_host` operation, the server v1 route's
 * request validator, and the CLI `hosts templates` lister. Adding/removing a
 * template here keeps all three in lockstep (no per-layer enum to drift).
 */
export const HOST_TEMPLATE_IDS = [
  "mcpjam",
  "claude",
  "claude-code",
  "chatgpt",
  "mistral",
  "goose",
  "slack",
  "cursor",
  "codex",
  "copilot",
  "vscode",
  "agentcore",
  "n8n",
  "perplexity",
  "cline",
  "notion",
] as const;

export type HostTemplateId = (typeof HOST_TEMPLATE_IDS)[number];

export interface SeedHostTemplateOptions {
  /**
   * Theme stamped into `hostContext.theme` (and for the MCPJam template,
   * threaded into `getMcpJamStyleVariables`) at creation time. Callers at
   * the host-creation seam pass MCPJam's current global `themeMode` so a
   * newly-created host opens matching the rest of the app instead of
   * defaulting to dark. Omitting it preserves the legacy "always dark"
   * behavior for callers that snapshot template defaults onto already-
   * existing surfaces (see `applyHostStyleToHostConfigInput`,
   * `applyHostDefaultsToPlayground`) where flipping to MCPJam's theme on
   * every brand-pill click would be a surprise.
   *
   * Codex ignores this — its template doesn't set `hostContext` at all
   * (no rendering surface, so no theme to honor).
   */
  theme?: HostThemeMode;
  /**
   * Version stamped into the mcpjam template's mcpProfile clientInfo/
   * hostInfo. The server passes its package version; the client passes the
   * Vite `__APP_VERSION__`. Only the mcpjam template reads it.
   */
  appVersion?: string;
}

const DEFAULT_SEED_THEME: HostThemeMode = "dark";

export interface HostTemplate {
  id: HostTemplateId;
  label: string;
  description: string;
  seed: (opts?: SeedHostTemplateOptions) => SeededHostConfigInput;
}

/**
 * Claude Code's native (non-MCP) tool surface, captured from a live
 * v2.1.176 session. These are the CLI's own harness tools — they never
 * cross the MCP wire, so they don't belong in `clientCapabilities`, and
 * no current host-config field can carry them (`builtInToolIds` is
 * validated against the backend built-in tool catalog; `computer` is the
 * Project Computers resource). Recorded verbatim so a future
 * computer-use / host-native-toolset feature can seed an honest Claude
 * Code environment instead of guessing. Deliberately NOT wired into the
 * "claude-code" template seed below.
 */
export const CLAUDE_CODE_NATIVE_TOOLS = {
  /** Always loaded at session start. */
  topLevel: [
    { name: "Agent", description: "launch subagents" },
    {
      name: "AskUserQuestion",
      description: "ask the user a multiple-choice question",
    },
    { name: "Bash", description: "run shell commands" },
    { name: "Edit", description: "exact string replacement in a file" },
    {
      name: "Read",
      description: "read files (text, images, PDFs, notebooks)",
    },
    { name: "ScheduleWakeup", description: "schedule a /loop resume" },
    {
      name: "ShareOnboardingGuide",
      description: "upload/share ONBOARDING.md",
    },
    { name: "Skill", description: "invoke a skill" },
    {
      name: "ToolSearch",
      description: "fetch schemas for deferred tools",
    },
    {
      name: "Workflow",
      description: "run a multi-agent orchestration script",
    },
    { name: "Write", description: "write/overwrite a file" },
  ],
  /**
   * Deferred: names are known up front, but schemas must be loaded via
   * ToolSearch before calling.
   */
  deferred: {
    taskManagement: [
      "TaskCreate",
      "TaskGet",
      "TaskList",
      "TaskOutput",
      "TaskStop",
      "TaskUpdate",
      "Monitor",
    ],
    cronSchedulingTriggers: [
      "CronCreate",
      "CronDelete",
      "CronList",
      "RemoteTrigger",
      "PushNotification",
    ],
    planWorktreeMode: [
      "EnterPlanMode",
      "ExitPlanMode",
      "EnterWorktree",
      "ExitWorktree",
      "DesignSync",
    ],
    filesWeb: ["NotebookEdit", "WebFetch", "WebSearch"],
    mcpGeneric: ["ListMcpResourcesTool", "ReadMcpResourceTool"],
  },
} as const;

export const HOST_TEMPLATES: readonly HostTemplate[] = [
  {
    id: "mcpjam",
    label: "MCPJam",
    description: "SDK defaults. Pick a model later.",
    // Explicit `hostStyle: "mcpjam"` so the template doesn't silently
    // inherit the registry default — keeps MCPJam hosts visually distinct
    // from Claude even if the default ever drifts.
    seed: (opts) => {
      const base = emptyHostConfigInputV2({ hostStyle: "mcpjam" });
      const theme = opts?.theme ?? DEFAULT_SEED_THEME;
      // MCPJam is the "out of the box" default the rest of the product
      // assumes works for every UI Resource. Goal: advertise the
      // maximal SEP-1865 host-side surface so a view designed for any
      // real host (Claude, ChatGPT, Cursor, Copilot) lands here and runs
      // without degrading. Each entry below mirrors a spec-defined or
      // widely-shipped host capability:
      //   - experimental:    opt-in surface for forward-compat features
      //   - openLinks:       ui/open-link (spec §HostCapabilities.openLinks)
      //   - downloadFile:    real-world extension (Claude ships it)
      //   - serverTools:     ui-iframe → tools/call proxy
      //   - serverResources: ui-iframe → resources/read proxy
      //   - logging:         notifications/message
      //   - updateModelContext: text + image content (matches Claude)
      //   - message:         text content (ui/message)
      // The `listChanged: true` flags are intentionally omitted — the
      // renderer doesn't yet forward those notifications (see
      // MCPJAM_HOST_STYLE comment); advertising them would be dishonest
      // until the renderer-side gap is closed.
      base.hostCapabilitiesOverride = {
        experimental: {},
        openLinks: {},
        downloadFile: {},
        serverTools: {},
        serverResources: {},
        logging: {},
        updateModelContext: { text: {}, image: {} },
        message: { text: {} },
      };
      // Per-resource hostContext for MCPJam's own house chrome. Style
      // variables come straight from the design-system tokens that
      // `client/src/index.css` imports via `@mcpjam/design-system`, so
      // a widget rendered in an MCPJam-styled host sees the same
      // surfaces/text/border tokens as the inspector itself. The theme
      // value below also threads into `getMcpJamStyleVariables(theme)` —
      // MCPJam's variables are JS-resolved (not CSS `light-dark()`), so
      // both need to flip together.
      // MCPJAM_FONT_CSS is empty (system font stack, no @font-face), so
      // `styles.css` is omitted entirely.
      base.hostContext = {
        theme,
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen", "pip"],
        containerDimensions: { width: 720, maxHeight: 5000 },
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        userAgent: "mcpjam-inspector",
        platform: MCPJAM_PLATFORM,
        deviceCapabilities: { touch: false, hover: true },
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        styles: {
          variables: getMcpJamStyleVariables(theme),
          ...(MCPJAM_FONT_CSS ? { css: { fonts: MCPJAM_FONT_CSS } } : {}),
        },
      };
      // Pin the inspector's identity in MCP `initialize.clientInfo`.
      // Without this, MCPClientManager falls through `defaultClientName`
      // (unset on the inspector's manager — see server/app.ts) all the
      // way to `serverId`, leaking the Convex doc id (e.g.
      // "mn73t86710zsv32exj7j4mxnbs86s52s") as the client name.
      // `(opts?.appVersion ?? DEFAULT_SEED_APP_VERSION)` is the same Vite build constant
      // mcp-apps-renderer.tsx uses for hostInfo.version, so the
      // inspector's MCP-side and Apps-side identities stay in lockstep.
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          clientInfo: {
            name: "mcpjam-inspector",
            version: opts?.appVersion ?? DEFAULT_SEED_APP_VERSION,
          },
        },
        apps: {
          // MCP Apps extension: hostInfo sent to the View iframe in
          // `ui/initialize`. Views that branch on hostInfo.name === "MCPJam"
          // (e.g. dev-tool-aware widgets) need this to identify the host.
          uiInitialize: {
            hostInfo: {
              name: "MCPJam",
              version: opts?.appVersion ?? DEFAULT_SEED_APP_VERSION,
            },
          },
          // Vendor compat-runtime shims the inspector injects into widget
          // HTML before sandboxing. MCPJam intentionally exposes
          // `window.openai` (OpenAI Apps SDK surface) so developers can
          // debug Apps-SDK widgets here without swapping to the ChatGPT
          // template. Stamped explicitly on the template (rather than
          // relying on the host style preset fallback) so the JSON in the
          // Apps Extension tab surfaces the field on day one and the
          // "window.openai" injected-globals chip reads as user-owned,
          // not "(from preset)".
          compatRuntime: { openaiApps: true },
          sandbox: {
            csp: {
              // Honor the view's declared `_meta.ui.csp` as-is. MCPJam is
              // a dev tool — narrowing host-side would silently drop a
              // developer's outbound calls and look like "my widget is
              // broken" when it's actually MCPJam intersecting the
              // allowlist to empty. Production hosts (Claude / ChatGPT /
              // Cursor) ship a `restrictTo` allowlist for end-user safety;
              // the inspector explicitly does not, so developers can debug
              // against any origin their view declares.
              mode: "declared",
            },
            permissions: {
              // Grant every SEP-1865 permission so any widget that
              // declares `_meta.ui.permissions` in good faith gets what
              // it asks for. Resource declaration is still the ceiling
              // (resolver intersects), so granting extras here is safe —
              // an unused grant is a no-op, an unanticipated denial
              // silently breaks features.
              mode: "custom",
              allow: {
                camera: true,
                microphone: true,
                geolocation: true,
                clipboardWrite: true,
              },
            },
          },
        },
      };
      return base;
    },
  },
  {
    id: "claude",
    label: "Claude",
    description: "Anthropic-style host.",
    seed: (opts) => {
      const base = emptyHostConfigInputV2({
        hostStyle: "claude",
        // Canonical id (anthropic/<slug>) so the chat-composer model
        // picker resolves it. Bare "claude-sonnet-4-5" never matched a
        // SUPPORTED_MODELS entry → silently fell back to default.
        // Haiku 4.5 is in MCPJAM_GUEST_ALLOWED_MODEL_IDS, so guests
        // pick it without an Anthropic key.
        modelId: "anthropic/claude-haiku-4.5",
        temperature: 1.0,
        requireToolApproval: false,
      });
      const theme = opts?.theme ?? DEFAULT_SEED_THEME;
      // clientCapabilities: Real claude.ai publishes only the SDK-default
      // MCP UI extension (no `experimental` flag). emptyHostConfigInputV2
      // already seeds that, so no override needed here — distinct from
      // the ChatGPT template, which adds `experimental.openai/visibility`.
      //
      // Override the preset advertise to match what real claude.ai
      // publishes in ui/initialize. `sandbox` is intentionally omitted —
      // the canonicalizer strips it from the override (sandbox is per-
      // resource at runtime per SEP-1865; see mcpProfile.apps.sandbox).
      // listChanged is advertised here even though the inspector's
      // renderer doesn't currently forward those notifications (see
      // host-styles/built-ins.ts:33–37) — kept faithful to real Claude
      // so apps that gate on it can detect the host. Resolving the
      // renderer gap is a separate enforcement-side fix.
      base.hostCapabilitiesOverride = {
        openLinks: {},
        downloadFile: {},
        serverTools: { listChanged: true },
        serverResources: { listChanged: true },
        logging: {},
        updateModelContext: { text: {}, image: {} },
        message: { text: {} },
      };
      // Per-resource environment context claude.ai exposes to MCP apps.
      // Skips `toolInfo` (per-invocation, fills at runtime).
      // `containerDimensions` is verbatim from claude.ai — clean policy
      // values (720px wide chat column, 5000px height cap). Per SEP-1865,
      // Views interpret `width: 720` as "fill your container with width:
      // 100vw" intent, not a literal claim about the inspector's iframe
      // width; widgets render at whatever the iframe is, the value
      // communicates Claude's layout policy.
      base.hostContext = {
        theme,
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions: { width: 720, maxHeight: 5000 },
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        platform: "web",
        deviceCapabilities: { touch: false, hover: true },
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        // SEP-1865 hostContext.styles. Anthropic Sans @font-face URLs
        // require `assets.claude.ai` in apps.sandbox.csp.resourceDomains
        // (set below). Variables use CSS `light-dark()` so they pick the
        // right side based on the iframe's `color-scheme` — no JS-side
        // theme threading required here.
        styles: {
          variables: CLAUDE_HOST_STYLE_VARIABLES,
          css: { fonts: CLAUDE_FONTS_CSS },
        },
      };
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          // Base MCP protocol: clientInfo sent to MCP servers during
          // `initialize`. Matches what real claude.ai publishes.
          clientInfo: { name: "claude-ai", version: "0.1.0" },
        },
        apps: {
          // MCP Apps extension: hostInfo sent to the View iframe in
          // `ui/initialize`. Apps that branch on `hostInfo.name === "Claude"`
          // need this to take that path.
          uiInitialize: {
            hostInfo: { name: "Claude", version: "1.0.0" },
          },
          sandbox: {
            csp: {
              // Honor the view's declared `_meta.ui.csp` as-is — no
              // host-side `restrictTo`. SEP-1865 makes restrictTo an
              // intersection with what the view declares, so any
              // hardcoded allowlist here can only narrow widgets, never
              // help them. Production hosts (real claude.ai) DO publish
              // a captured set (anthropic / openai / jsdelivr) — but
              // mirroring that here propagates a widget-breaking default
              // (e.g. esm.sh-loading views go silent) without giving
              // users any protection MCPJam itself owns. Users who want
              // to model the production allowlist can add it explicitly
              // in the editor; absence here means "trust the view".
              mode: "declared",
              // cspDirectives — verbatim from a live claude.ai inner-iframe
              // response CSP header (captured 2026-05-18 via DevTools →
              // Network → Response Headers). These layer on top of
              // SEP-1865's restrictive baseline via the union merge in
              // buildCSP (sandbox-proxy.html). Tokens already in the
              // baseline (`'unsafe-inline'` for script-src/style-src,
              // `data:`/`blob:` for img/font/media) are omitted to keep
              // the data set minimal — the merge dedupes regardless.
              //
              // 'unsafe-eval' enables `eval()` / `new Function()` — real
              // Claude allows this; widgets relying on runtime-compiled
              // templating (Handlebars, Vue full build, etc.) work here
              // but break in hosts that don't grant it.
              //
              // `esm.sh` + `assets.claude.ai` are public CDNs Claude
              // adds at the proxy layer (NOT in advertised metadata).
              // Including them here is safe under the union merge rule
              // (PR 2142) — they can only grant capabilities, never
              // narrow what a widget declared.
              cspDirectives: {
                "script-src": [
                  "'self'",
                  "'unsafe-eval'",
                  "https://esm.sh",
                  "https://assets.claude.ai",
                ],
                "style-src": [
                  "'self'",
                  "https://esm.sh",
                  "https://assets.claude.ai",
                ],
                "img-src": [
                  "'self'",
                  "https://esm.sh",
                  "https://assets.claude.ai",
                ],
                "connect-src": ["'self'", "https://esm.sh"],
                "font-src": [
                  "'self'",
                  "https://esm.sh",
                  "https://assets.claude.ai",
                ],
                "media-src": [
                  "'self'",
                  "https://esm.sh",
                  "https://assets.claude.ai",
                ],
                "worker-src": [
                  "'self'",
                  "blob:",
                  "https://esm.sh",
                  "https://assets.claude.ai",
                ],
                "frame-src": ["'self'"],
                "base-uri": ["'self'"],
                "form-action": ["'self'"],
              },
            },
            permissions: {
              mode: "custom",
              allow: { clipboardWrite: true },
            },
            // sandboxAttrs — from live capture of real claude.ai's outer
            // and inner iframes (both carry `allow-scripts allow-same-origin
            // allow-forms`). The first two are spec-mandated; `allow-forms`
            // is the host's addition so `<form>` POSTs work inside widgets.
            sandboxAttrs: ["allow-forms"],
            // allowFeatures — non-spec Permissions Policy entries on the
            // OUTER iframe. Claude's outer grants `fullscreen *; clipboard-
            // write *`; clipboard-write is the spec permission (lives in
            // `permissions.allow` above), fullscreen is the non-spec extra
            // captured here. The inner iframe trims fullscreen out (see
            // sandbox-proxy.html: inner gets spec-4 only), matching real
            // claude.ai's outer-grants / inner-trims pattern.
            allowFeatures: { fullscreen: "*" },
          },
        },
      };
      return base;
    },
  },
  {
    id: "claude-code",
    label: "Claude Code",
    description:
      "Anthropic's coding CLI. Roots + form elicitation, no widget rendering.",
    seed: () => {
      const base = emptyHostConfigInputV2({
        // Dedicated Claude Code skin (CLAUDE_CODE_HOST_STYLE in
        // client-styles/built-ins.ts) — borrows Claude's chat surface but
        // ships its own brand logo and a CLI spinner thinking indicator
        // instead of the claude.ai mascot.
        hostStyle: "claude-code",
        // Same guest-allowed Anthropic model rationale as the Claude
        // template — the real CLI's model choice never crosses the MCP
        // wire, so this is a product default, not probe data.
        modelId: "anthropic/claude-haiku-4.5",
        temperature: 1.0,
        requireToolApproval: false,
      });
      // Verbatim from a live mcpjam-learn `start-host-probe` against
      // Claude Code CLI v2.1.176: raw `initialize` capabilities are
      // exactly `{ roots: {}, elicitation: {} }` — roots without
      // `listChanged`, elicitation the SDK parses as form-mode, and NO
      // `extensions["io.modelcontextprotocol/ui"]`. Replace the SDK
      // default entirely rather than spreading on top — a spread would
      // leak the UI extension back in and misrepresent Claude Code as a
      // UI-capable client (same move as the Codex template).
      base.clientCapabilities = {
        roots: {},
        elicitation: {},
      };
      // Progressive tool discovery ON. Product choice, not probe data —
      // tool disclosure isn't an MCP `initialize` capability, so nothing
      // about it was (or could be) extracted from the host probe.
      base.progressiveToolDiscovery = true;
      // CLI client: no widget rendering, so `hostContext` stays the
      // empty object.
      //
      // Zero out the host-side app advertise. We reuse `hostStyle:
      // "claude"` for Anthropic chrome, but the Claude style's preset
      // advertises claude.ai's full app surface (openLinks, serverTools,
      // serverResources, logging, …) — none of which Claude Code has,
      // since it renders no MCP Apps. `{}` is the explicit "advertise
      // nothing" override (resolveEffectiveHostCapabilities treats `{}`
      // distinctly from `undefined`/preset-inherit), so the Apps tab
      // honestly shows an empty hostCapabilities for the CLI instead of
      // inheriting Claude's. None of this was in the probe — the CLI
      // returned no ui/initialize snapshot at all.
      base.hostCapabilitiesOverride = {};
      //
      // The CLI's native harness toolset (Bash/Read/Write/etc.) is
      // catalogued in CLAUDE_CODE_NATIVE_TOOLS above for a future
      // computer-use feature; intentionally not attached to this seed.
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          supportedProtocolVersions: ["2025-11-25"],
          // Verbatim from the same probe. `title` / `description` /
          // `websiteUrl` land in the pass-through
          // `Record<string, unknown>` per host-config-v2 (backend
          // soft-validates name/version only).
          clientInfo: {
            name: "claude-code",
            title: "Claude Code",
            version: "2.1.176",
            description: "Anthropic's agentic coding tool",
            websiteUrl: "https://claude.com/claude-code",
          },
        },
      };
      return base;
    },
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    description: "OpenAI-style host with ChatGPT protocol.",
    seed: (opts) => {
      const base = emptyHostConfigInputV2({
        hostStyle: "chatgpt",
        // Canonical id (openai/<slug>) so the chat-composer model picker
        // resolves it. Bare "gpt-5" never matched a SUPPORTED_MODELS
        // entry → silently fell back. `gpt-5-nano` is the smallest free
        // GPT-5 variant in MCPJAM_GUEST_ALLOWED_MODEL_IDS — guests get
        // it without an OpenAI key. Bigger GPT-5s (5.4/5.5) are gated.
        modelId: "openai/gpt-5-nano",
        temperature: 0.7,
        requireToolApproval: false,
      });
      const theme = opts?.theme ?? DEFAULT_SEED_THEME;
      // Real ChatGPT advertises an `experimental.openai/visibility` flag on top
      // of the SDK-default MCP UI extension. Keep the default extension block
      // (mime types) intact; only add the openai-specific experimental key.
      base.clientCapabilities = {
        ...base.clientCapabilities,
        experimental: {
          "openai/visibility": { enabled: true },
        },
      };
      // Override the preset advertise to match what real ChatGPT publishes in
      // ui/initialize. `sandbox` is intentionally omitted — host-config-v2's
      // canonicalizer strips it from the override anyway (sandbox is per-
      // resource at runtime per SEP-1865; see mcpProfile.apps.sandbox below).
      base.hostCapabilitiesOverride = {
        openLinks: {},
        serverTools: {},
        serverResources: {},
        logging: {},
        message: {},
        updateModelContext: {},
      };
      // Per-resource environment context ChatGPT exposes to MCP apps. Skips
      // `toolInfo` (per-invocation, fills at runtime). `containerDimensions`
      // is included as host policy per SEP-1865 — Views interpret it as
      // "fill your container" intent, not a literal viewport claim. Real
      // ChatGPT publishes `maxWidth: 767.984375` (runtime-measured
      // viewport-minus-padding); rounded to the md breakpoint (768) so the
      // template communicates intent rather than freezing a snapshot.
      base.hostContext = {
        theme,
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen", "pip"],
        containerDimensions: { height: 400, maxWidth: 768 },
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        userAgent: "chatgpt",
        platform: "desktop",
        deviceCapabilities: {
          touch: false,
          hover: true,
        },
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      };
      // Host-level MCP profile: identify as openai-mcp during MCP
      // initialize, and lock the iframe CSP down to the same connect/resource
      // domain set real ChatGPT publishes. `mode: "declared"` keeps each
      // resource's own CSP authoritative; `restrictTo` intersects on top so
      // an MCP app can never reach a domain ChatGPT itself wouldn't allow.
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          // Base MCP protocol: clientInfo sent to MCP servers during
          // `initialize`. Matches what real ChatGPT publishes.
          clientInfo: { name: "openai-mcp", version: "1.0.0" },
        },
        apps: {
          // MCP Apps extension: hostInfo sent to the View iframe in
          // `ui/initialize`. Different protocol layer from clientInfo
          // above — apps that branch on `hostInfo.name === "chatgpt"`
          // (e.g. OpenAI Apps SDK widgets) need this to take that path.
          uiInitialize: {
            hostInfo: { name: "chatgpt", version: "0.0.1" },
          },
          // Vendor compat-runtime shims. Real ChatGPT exposes the
          // OpenAI Apps SDK `window.openai` surface to widget HTML, so
          // emulating it here keeps existing Apps SDK widgets rendering
          // as their authors intended. Stamped on the template so the
          // JSON editor surfaces the field on day one — without this,
          // the field would only appear after a manual edit and the
          // injected-globals chip would read "(from preset)".
          compatRuntime: { openaiApps: true },
          sandbox: {
            csp: {
              // No host-side `restrictTo` — see the Claude template for
              // the full rationale. Real ChatGPT does ship the same
              // captured allowlist (anthropic / openai / jsdelivr), but
              // mirroring it here only narrows the view's declared CSP
              // (intersection trap) and silently breaks widgets reaching
              // any other origin. The view's declaration is authoritative.
              mode: "declared",
              // cspDirectives — verbatim from a live chatgpt response
              // Content-Security-Policy header (captured 2026-05-18 via
              // DevTools → Network → oaiusercontent.com response).
              //
              // Real ChatGPT's outer-doc CSP is strikingly minimal: only
              // `frame-ancestors`, `frame-src`, and the CSP `sandbox`
              // directive are emitted. There is NO `script-src`,
              // `style-src`, `connect-src` etc. — script and style
              // execution is effectively unconstrained at the host layer.
              // `frame-ancestors` is dropped (controls who can embed the
              // doc — irrelevant for widget runtime); the CSP `sandbox`
              // directive duplicates `sandboxAttrs` below and is modeled
              // there. That leaves just `frame-src` as the meaningful
              // host-emitted constraint on widget behavior.
              cspDirectives: {
                "frame-src": ["'self'", "https:", "data:", "blob:"],
              },
            },
            permissions: {
              mode: "custom",
              // Per ui/initialize hostCapabilities only `microphone` is
              // advertised. Per the outer iframe `allow=` attribute,
              // `clipboard-write` is ALSO emitted at runtime even though
              // it's not in the advertised metadata. Include both so a
              // widget testing in MCPJam-as-ChatGPT actually gets what
              // the production iframe grants.
              allow: { microphone: true, clipboardWrite: true },
            },
            // sandboxAttrs — captured 2026-05-18 from the outer and
            // inner iframe `sandbox=` attributes. There's an asymmetry:
            //   outer: allow-scripts allow-same-origin allow-forms
            //   inner: allow-scripts allow-same-origin allow-popups
            //          allow-popups-to-escape-sandbox allow-forms
            // Schema applies one set to both layers; use the broader
            // inner set since that's what determines widget runtime
            // behavior. Outer will over-grant allow-popups in MCPJam vs
            // real ChatGPT; the modal-popup widget surface is rare
            // enough that this divergence is acceptable.
            sandboxAttrs: [
              "allow-forms",
              "allow-popups",
              "allow-popups-to-escape-sandbox",
            ],
            // allowFeatures — non-spec Permissions Policy extras on the
            // outer iframe. Real ChatGPT emits
            // `clipboard-write *; local-network-access *; microphone *;
            // midi *`:
            //   - clipboard-write + microphone → spec features, modeled
            //     in `permissions.allow` above.
            //   - local-network-access + midi → ALREADY in MCPJam's
            //     renderer baseline (sandboxed-iframe.tsx's
            //     `outerAllowAttribute` memo), auto-granted to every
            //     host.
            // So ChatGPT contributes no host-specific allowFeatures
            // extras — the runtime grant matches real ChatGPT for free.
          },
        },
      };
      return base;
    },
  },
  {
    id: "mistral",
    label: "Mistral",
    description: "Mistral web host. MCP Apps, no OpenAI shim.",
    seed: (opts) => {
      const base = emptyHostConfigInputV2({
        hostStyle: "mistral",
        // Default the Mistral host to Mistral Large 3 2512 (MCPJam-hosted).
        modelId: "mistralai/mistral-large-2512",
        temperature: 0.7,
        requireToolApproval: false,
      });
      const theme = opts?.theme ?? DEFAULT_SEED_THEME;

      // Le Chat's captured base MCP `initialize` reported:
      //   clientInfo: { name: "mcp", version: "0.1.0" }
      //   clientCapabilities: {}
      // But the same capture rendered MCP Apps and completed ui/initialize.
      // For the normalized MCPJam template, advertise the standard MCP Apps
      // extension explicitly so the canvas/runtime reflect the capability
      // Le Chat demonstrated instead of preserving a contradictory raw quirk.
      base.clientCapabilities = {
        extensions: {
          [MCP_UI_EXTENSION_ID]: {
            mimeTypes: [MCP_UI_RESOURCE_MIME_TYPE],
          },
        },
      };
      base.hostCapabilitiesOverride = {
        openLinks: {},
        serverTools: {},
        serverResources: {},
        logging: {},
        updateModelContext: { text: {} },
        message: { text: {}, image: {} },
      };
      base.hostContext = {
        theme,
        displayMode: "fullscreen",
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions: { width: 1130.5 },
        locale: "en",
        timeZone: "America/Los_Angeles",
        userAgent: "Le Chat/1.0.0",
        platform: "web",
        deviceCapabilities: { touch: false, hover: true },
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        styles: {
          variables: getMistralStyleVariables(theme),
        },
      };
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          supportedProtocolVersions: ["2025-11-25"],
          clientInfo: { name: "mcp", version: "0.1.0" },
        },
        apps: {
          uiInitialize: {
            hostInfo: { name: "Le Chat", version: "1.0.0" },
          },
          mcpAppsOverrides: {
            availableDisplayModes: ["inline", "fullscreen"],
            toolInputPartial: true,
            toolCancelled: false,
            hostContextChanged: true,
            resourceTeardown: false,
            toolInfo: false,
            openLinks: true,
            serverTools: true,
            serverResources: true,
            logging: true,
            updateModelContext: true,
            message: true,
            sandboxPermissions: true,
            cspFrameDomains: false,
            cspBaseUriDomains: false,
            resourcePrefersBorder: false,
            downloadFile: false,
            requestTeardown: false,
            widgetDisplayModeRequests: "accept",
          },
          compatRuntime: { openaiApps: false },
          sandbox: {
            csp: {
              mode: "declared",
              restrictTo: {
                connectDomains: [
                  "https://api.openai.com",
                  "https://api.anthropic.com",
                  "https://cdn.jsdelivr.net",
                ],
                resourceDomains: ["https://cdn.jsdelivr.net"],
              },
            },
            permissions: {
              mode: "custom",
              allow: { clipboardWrite: true },
            },
            sandboxAttrs: ["allow-forms"],
          },
        },
      };
      return base;
    },
  },
  {
    id: "goose",
    label: "Goose",
    description:
      "Goose Desktop. MCP Apps rendering, no OpenAI compatibility shim.",
    seed: (opts) => {
      const base = emptyHostConfigInputV2({
        hostStyle: "goose",
        // Goose Desktop is model-provider agnostic. Use MCPJam's smallest
        // hosted model so the simulated chat runs before a user wires their
        // own Goose-like model stack.
        modelId: "openai/gpt-5-nano",
        temperature: 0.7,
        requireToolApproval: false,
      });
      const theme = opts?.theme ?? DEFAULT_SEED_THEME;

      // Captured from Goose Desktop 1.38.0: the client advertises MCP UI
      // support plus roots, sampling, and elicitation. Preserve the raw
      // empty-object shapes instead of normalizing elicitation to
      // `{ form: {} }` so the MCP initialize layer stays faithful.
      base.clientCapabilities = {
        extensions: {
          [MCP_UI_EXTENSION_ID]: {
            mimeTypes: [MCP_UI_RESOURCE_MIME_TYPE],
          },
        },
        roots: {},
        sampling: {},
        elicitation: {},
      };

      // Progressive tool discovery ON for Goose-shaped hosts. Product
      // choice, not probe data: tool disclosure is an MCPJam execution
      // policy and does not appear in the MCP initialize handshake.
      base.progressiveToolDiscovery = true;

      // Goose's captured `ui/initialize` response only advertised
      // `openLinks`. It rendered the View and supplied rich HostContext,
      // but did not claim serverTools, resources, logging, message, or
      // updateModelContext.
      base.hostCapabilitiesOverride = {
        openLinks: {},
      };

      base.hostContext = {
        theme,
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen", "pip"],
        containerDimensions: { width: 1274 },
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Goose/1.38.0 Chrome/146.0.7680.65 Electron/41.0.0 Safari/537.36",
        platform: GOOSE_PLATFORM,
        deviceCapabilities: { touch: false, hover: true },
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        styles: {
          variables: GOOSE_HOST_STYLE_VARIABLES,
          css: { fonts: GOOSE_FONT_CSS },
        },
      };

      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          supportedProtocolVersions: ["2025-03-26"],
          clientInfo: { name: "goose-desktop", version: "1.38.0" },
        },
        apps: {
          uiInitialize: {
            hostInfo: { name: "MCP-UI Host", version: "1.0.0" },
          },
          mcpAppsOverrides: {
            availableDisplayModes: ["inline", "fullscreen", "pip"],
            toolInputPartial: false,
            toolCancelled: false,
            hostContextChanged: false,
            resourceTeardown: false,
            toolInfo: true,
            openLinks: true,
            serverTools: false,
            serverResources: false,
            logging: false,
            updateModelContext: false,
            message: false,
            sandboxPermissions: false,
            cspFrameDomains: false,
            cspBaseUriDomains: false,
            resourcePrefersBorder: false,
            downloadFile: false,
            requestTeardown: false,
            widgetDisplayModeRequests: "accept",
          },
          compatRuntime: { openaiApps: false },
          sandbox: {
            csp: {
              mode: "declared",
              cspDirectives: {
                "font-src": ["https://cash-f.squarecdn.com"],
              },
            },
            permissions: {
              mode: "custom",
              allow: {},
            },
            sandboxAttrs: ["allow-forms"],
          },
        },
      };
      return base;
    },
  },
  {
    id: "slack",
    label: "Slack",
    description:
      "Slack MCP client. MCP Apps rendering, no OpenAI compatibility shim.",
    seed: (opts) => {
      const base = emptyHostConfigInputV2({
        hostStyle: "slack",
        // Slack's MCP client is model-provider agnostic toward the server.
        // Use MCPJam's smallest hosted model so simulated chats run before a
        // user wires their own Slack-shaped model stack.
        modelId: "openai/gpt-5-nano",
        temperature: 0.7,
        requireToolApproval: false,
      });
      const theme = opts?.theme ?? DEFAULT_SEED_THEME;

      // Captured from Slack on 2026-06-24: the base MCP initialize path
      // advertises only the MCP UI extension. Preserve that exact surface.
      base.clientCapabilities = {
        extensions: {
          [MCP_UI_EXTENSION_ID]: {
            mimeTypes: [MCP_UI_RESOURCE_MIME_TYPE],
          },
        },
      };

      // Captured from Slack's `ui/initialize` response. No
      // updateModelContext/message/downloadFile claims were present.
      base.hostCapabilitiesOverride = {
        openLinks: {},
        serverTools: {},
        serverResources: {},
        logging: {},
      };

      // Per-resource environment context Slack exposes to MCP apps.
      // `toolInfo` is omitted here because it is per-invocation and filled by
      // the renderer when the matrix enables it.
      base.hostContext = {
        theme,
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions: { maxWidth: 598 },
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        platform: "web",
        deviceCapabilities: { touch: false, hover: true },
        styles: {
          variables: getSlackStyleVariables(theme),
          css: { fonts: SLACK_FONT_CSS },
        },
      };

      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          supportedProtocolVersions: ["2025-06-18"],
          clientInfo: { name: "Slack MCP Client", version: "1.0.0" },
        },
        apps: {
          uiInitialize: {
            hostInfo: { name: "Slack", version: "1.0.0" },
          },
          mcpAppsOverrides: {
            availableDisplayModes: ["inline", "fullscreen"],
            toolInputPartial: false,
            toolCancelled: false,
            hostContextChanged: false,
            resourceTeardown: false,
            toolInfo: true,
            openLinks: true,
            serverTools: true,
            serverResources: true,
            logging: true,
            updateModelContext: false,
            message: false,
            sandboxPermissions: false,
            cspFrameDomains: false,
            cspBaseUriDomains: false,
            resourcePrefersBorder: false,
            downloadFile: false,
            requestTeardown: false,
            widgetDisplayModeRequests: "accept",
          },
          compatRuntime: { openaiApps: false },
          sandbox: {
            csp: {
              // Slack proxies the View with the resource-declared CSP payload
              // in the sandbox URL. Do not add a host-side restrictTo
              // allowlist: that would intersect with the View declaration and
              // can only make widgets fail under MCPJam-as-Slack.
              mode: "declared",
            },
            permissions: {
              mode: "custom",
              // The captured iframe had no `allow` attribute, so do not grant
              // resource-declared permissions until Slack is observed doing so.
              allow: {},
            },
            // Captured iframe sandbox:
            // `allow-scripts allow-same-origin allow-forms`. The first two
            // are the renderer baseline; `allow-forms` is Slack's addition.
            sandboxAttrs: ["allow-forms"],
          },
        },
      };
      return base;
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    description:
      "Cursor IDE chat panel. MCP UI extension on, no message/updateModelContext.",
    seed: (opts) => {
      const base = emptyHostConfigInputV2({
        hostStyle: "cursor",
        // Canonical id (anthropic/<slug>) so the chat-composer model
        // picker resolves it. Bare "claude-sonnet-4-5" never matched a
        // SUPPORTED_MODELS entry → silently fell back. Sonnet 4.5 is in
        // MCPJAM_GUEST_ALLOWED_MODEL_IDS (4.6 is gated); guests get it
        // without an Anthropic key. Anthropic-flavored default matches
        // Cursor's typical chat config — users can swap any model after.
        modelId: "anthropic/claude-sonnet-4.5",
        temperature: 0.7,
        requireToolApproval: false,
        // Real Cursor (3.4.20 probe) doesn't yet implement SEP-1865
        // visibility filtering — app-only tools still flow to the model.
        // Faithful mirror: MCPJam-as-Cursor leaves visibility off so the
        // inspector behaves the same way. Every other template inherits
        // the spec-default `true` via emptyHostConfigInputV2.
        respectToolVisibility: false,
      });
      const theme = opts?.theme ?? DEFAULT_SEED_THEME;
      // clientCapabilities: matches what real Cursor publishes during MCP
      // `initialize` — declares MCP UI support plus its own elicitation
      // and roots flags. We keep the SDK-default UI extension entry
      // (`mimeTypes: ["text/html;profile=mcp-app"]`) and layer the
      // cursor-specific `elicitation` / `roots` declarations on top.
      base.clientCapabilities = {
        ...base.clientCapabilities,
        elicitation: { form: {} },
        roots: { listChanged: false },
      };
      // hostCapabilities override: captured verbatim from a Cursor 3.4.20
      // probe. Notably no `updateModelContext` and no `message` (Cursor
      // doesn't surface a way for widgets to push text back to the model
      // turn or seed the next user message). `listChanged: false` is
      // explicit — apps that gate on it need to know real Cursor doesn't
      // forward those notifications.
      base.hostCapabilitiesOverride = {
        openLinks: {},
        serverTools: { listChanged: false },
        serverResources: { listChanged: false },
        logging: {},
      };
      // Per-resource environment context Cursor exposes to MCP apps.
      // `containerDimensions` and theming come straight from the probe;
      // `availableDisplayModes` is a single-element list because Cursor
      // currently only renders inline (no fullscreen / pip).
      base.hostContext = {
        theme,
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        containerDimensions: { width: 649, maxHeight: 800 },
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        userAgent: "cursor",
        platform: "desktop",
      };
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          // Base MCP protocol: clientInfo sent to MCP servers during
          // `initialize`. Matches Cursor's outer-IDE identity.
          clientInfo: { name: "cursor-vscode", version: "1.0.0" },
        },
        apps: {
          uiInitialize: {
            // MCP Apps extension: hostInfo sent to the View iframe in
            // `ui/initialize`. Apps that branch on `hostInfo.name === "Cursor"`
            // need this to take that path. Version pinned to a real probed
            // build; bump when capturing a fresh probe.
            hostInfo: { name: "Cursor", version: "3.4.20" },
          },
          sandbox: {
            csp: {
              // No host-side `restrictTo` — see the Claude template for
              // the full rationale. Cursor's live probe ships the same
              // canonical AI-lab allowlist, but mirroring it would
              // intersect-trap any widget reaching another origin.
              mode: "declared",
            },
            permissions: {
              // Only clipboardWrite per probe; everything else stays off.
              mode: "custom",
              allow: { clipboardWrite: true },
            },
          },
        },
      };
      return base;
    },
  },
  {
    id: "codex",
    label: "Codex",
    description:
      "OpenAI Codex CLI. Elicitation-only client, no widget rendering.",
    seed: () => {
      const base = emptyHostConfigInputV2({
        // Dedicated Codex skin (OpenAI Apps SDK profile + ChatGPT chat
        // surface colors + the shimmering "Thinking" indicator). See
        // CODEX_HOST_STYLE in client-styles/built-ins.ts.
        hostStyle: "codex",
        // Canonical id (openai/<slug>) so the chat-composer model picker
        // resolves it. gpt-5-nano is in MCPJAM_GUEST_ALLOWED_MODEL_IDS, so
        // guests get it without an OpenAI key; users can swap to a
        // codex-specific model after creation.
        modelId: "openai/gpt-5-nano",
        temperature: 0.7,
        requireToolApproval: false,
      });
      // Codex CLI probe advertises only elicitation. It does NOT advertise
      // the MCP UI extension (no widget rendering), so we replace the SDK
      // default clientCapabilities entirely rather than spreading on top —
      // a spread would leak `extensions["io.modelcontextprotocol/ui"]`
      // back in and misrepresent Codex as a UI-capable client.
      base.clientCapabilities = {
        elicitation: {},
      };
      // Codex is a CLI: it doesn't render MCP Apps views, so no
      // hostContext (styles/displayMode/containerDimensions are
      // meaningless without a renderer). Leaving `hostContext` as the
      // empty object from emptyHostConfigInputV2.
      //
      // Same reasoning for hostCapabilitiesOverride: there's no
      // ui/initialize negotiation, so we don't override what the preset
      // advertises. The preset's chatgpt advertise is irrelevant in
      // practice because no widget will ever read it from Codex.
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          supportedProtocolVersions: ["2025-06-18"],
          // Verbatim from a real Codex CLI probe. `title` lands in the
          // pass-through `Record<string, unknown>` per host-config-v2
          // (backend soft-validates name/version only).
          clientInfo: {
            name: "codex-mcp-client",
            title: "Codex",
            version: "0.131.0-alpha.9",
          },
        },
      };
      return base;
    },
  },
  {
    id: "copilot",
    label: "Copilot",
    description: "Microsoft 365 Copilot host. OpenAI-shaped Apps SDK.",
    seed: (opts) => {
      const base = emptyHostConfigInputV2({
        hostStyle: "copilot",
        // Real Microsoft 365 Copilot routes through OpenAI's chat-class
        // models under the hood, so the OpenAI-shaped Apps SDK is the
        // right protocol bucket here. `openai/gpt-5.3-chat` is the closest
        // MCPJam-guest-allowed analog (Copilot's flagship is chat-tuned,
        // not nano-tier), so the App Builder works out-of-the-box without
        // a BYOK while staying faithful to the host's real model class.
        modelId: "openai/gpt-5.3-chat",
        temperature: 0.7,
        requireToolApproval: false,
      });
      const theme = opts?.theme ?? DEFAULT_SEED_THEME;
      // Copilot's MCP client identity is not publicly documented; declare
      // an experimental `microsoft/copilot` flag so any app that branches
      // on it can detect the host. Keep the SDK-default UI extension entry
      // (`mimeTypes: ["text/html;profile=mcp-app"]`) intact.
      base.clientCapabilities = {
        ...base.clientCapabilities,
        experimental: { "microsoft/copilot": { enabled: true } },
      };
      // Capability advertise: tracks Microsoft's published "Supported MCP
      // Apps capabilities in Copilot" table. Only `app.openLink`,
      // `app.callServerTool`, `app.sendMessage`, and `app.updateModelContext`
      // are documented as supported; `app.sendLog` is explicitly ❌, and
      // there is no documented `callServerResource`/`readResource` bridge in
      // Copilot — so `logging` and `serverResources` are intentionally
      // omitted. `text` sub-fields mirror the style entry for consistency.
      // Source: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-mcp-apps#supported-mcp-apps-capabilities-in-copilot
      base.hostCapabilitiesOverride = {
        openLinks: {},
        serverTools: {},
        message: { text: {} },
        updateModelContext: { text: {} },
      };
      // Per-resource environment context. `containerDimensions` communicates
      // a flexible-height policy (widget can grow up to `maxHeight: 400`),
      // matching Copilot's documented `viewport.maxHeight` model — the doc
      // maps `window.openai.maxHeight` → `app.getHostContext()?.viewport?.maxHeight`,
      // i.e. a flexible vertical bound (widget scrolls up to a max), not a
      // fixed render-at-400 directive. NOTE: the MCPJam renderer currently
      // applies `ui/notifications/size-changed.height` directly to the
      // iframe without clamping against `containerDimensions.maxHeight`
      // (mcp-apps-renderer.tsx), so a widget reporting `height: 900` will
      // render at 900px in MCPJam-as-Copilot even though real Copilot
      // would scroll/cap at 400px. Renderer-level enforcement is a
      // follow-up that affects every template with a `maxHeight` (Claude
      // 5000, MCPJam 5000); until it lands, treat this profile as a
      // best-effort "tells widgets the cap" advertise — overflowing
      // widgets will look fine here but not in production Copilot.
      // `availableDisplayModes` is kept as
      // ["inline", "fullscreen"] because omitting it falls back to the
      // inspector default ["inline", "pip", "fullscreen"], which would
      // claim `pip` support Copilot doesn't have — a worse lie than the
      // known minor gap that Microsoft's docs mark
      // `app.getHostContext()?.availableDisplayModes` as ❌ (Copilot
      // widgets can't actually introspect this field on the real host).
      base.hostContext = {
        theme,
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions: { maxHeight: 400, maxWidth: 768 },
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        // Undocumented; chosen to match the `clientInfo.name` convention.
        userAgent: "ms-copilot",
        // Undocumented; Copilot is also a web app at `m365.cloud.microsoft`,
        // but kept as "desktop" to match the ChatGPT template behavior.
        platform: "desktop",
        deviceCapabilities: { touch: false, hover: true },
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      };
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          // Base MCP protocol: clientInfo sent during MCP `initialize`.
          // Matches Microsoft's "ms-copilot" identity convention. The
          // specific name/version values are guesses (no live probe and no
          // learn.microsoft.com source confirms them).
          clientInfo: { name: "ms-copilot", version: "1.0.0" },
        },
        apps: {
          uiInitialize: {
            // MCP Apps extension: hostInfo sent in `ui/initialize`. Apps
            // that branch on `hostInfo.name === "Copilot"` need this to
            // take that path. The specific name/version values are guesses
            // (no live probe and no learn.microsoft.com source confirms them).
            hostInfo: { name: "Copilot", version: "1.0.0" },
          },
          // Vendor compat-runtime shims. Copilot routes widgets through
          // the OpenAI Apps SDK under the hood, so the `window.openai`
          // surface is expected. Stamped on the template (rather than
          // inherited from the preset) so the JSON editor surfaces the
          // field on day one and the injected-globals chip reads as a
          // template choice, not "(from preset)".
          compatRuntime: { openaiApps: true },
          sandbox: {
            csp: {
              // No host-side `restrictTo` on connect/resource/baseUri
              // — see the Claude template for the full rationale. Real
              // Copilot publishes its own allowlist (AI APIs + jsDelivr
              // + Microsoft Graph + Office CDN), but mirroring it here
              // would only narrow the view's declared CSP via the
              // SEP-1865 intersection rule and silently break widgets
              // reaching anything else.
              //
              // `frameDomains: []` IS set below — Microsoft's doc marks
              // `frameDomains` as ❌ for Copilot (real Copilot drops the
              // field), and the symmetric move is to deny iframe nesting
              // at the host layer too. Encoded as an explicit empty
              // allowlist so the intent is captured in the config; the
              // SEP-1865 schema is allowlist-only by design (no deny
              // primitive — see CspDomainSet in client-config-v2.ts), and
              // the current MCP Apps renderer gates `restrictToConfigured`
              // on non-empty arrays, so this empty-list intent is not yet
              // enforced at runtime. Renderer-side enforcement (treat an
              // explicit empty allowlist as deny) is a follow-up that
              // pairs with the `containerDimensions.maxHeight` clamp
              // noted above — until both land, iframe-nesting widgets
              // will work in MCPJam-as-Copilot but fail in production.
              mode: "declared",
              restrictTo: { frameDomains: [] },
            },
            permissions: {
              mode: "custom",
              // Deny by default. Microsoft's doc marks
              // `_meta.ui.permissions` ❌ (Copilot ignores permissions
              // a widget declares in its resource `_meta.ui`) and says
              // nothing about which Permissions-Policy features Copilot
              // attaches to its own iframe. The only documented signal
              // is "no permissions surface", so MCPJam-as-Copilot
              // mirrors that: granting nothing rather than inventing a
              // host-side grant. Other vendor templates set
              // `clipboardWrite: true` from live probes — Copilot has
              // no equivalent capture, so we hold the line.
              allow: {},
            },
          },
        },
      };
      return base;
    },
  },
  {
    id: "vscode",
    label: "VS Code",
    description:
      "Visual Studio Code chat panel (GitHub Copilot). MCP UI extension on, no message/updateModelContext.",
    seed: (opts) => {
      const base = emptyHostConfigInputV2({
        hostStyle: "vscode",
        // VS Code Copilot Chat offers both OpenAI and Anthropic models;
        // default to the same guest-allowed Anthropic model as Cursor
        // (Sonnet 4.5 is in MCPJAM_GUEST_ALLOWED_MODEL_IDS) so the App
        // Builder works without a BYOK key. Users can swap any model after.
        modelId: "anthropic/claude-sonnet-4.5",
        temperature: 0.7,
        requireToolApproval: false,
        // VS Code, like Cursor, doesn't yet implement SEP-1865 visibility
        // filtering — leave it off to mirror that. Best-effort: no live VS
        // Code probe yet, so capability values are inherited from Cursor's.
        respectToolVisibility: false,
      });
      const theme = opts?.theme ?? DEFAULT_SEED_THEME;
      // VS Code is the editor Cursor forks (Cursor's own clientInfo.name is
      // "cursor-vscode"). Its MCP client declares the UI extension plus
      // elicitation and roots, same shape as Cursor. Keep the SDK-default
      // UI extension entry and layer those on top. Values inherited from
      // Cursor's probe pending a dedicated VS Code capture.
      base.clientCapabilities = {
        ...base.clientCapabilities,
        elicitation: { form: {} },
        roots: { listChanged: true },
      };
      // hostCapabilities: mirror Cursor's subset (VS Code shares the editor
      // base). No `updateModelContext` / `message`; `listChanged: false`
      // markers kept explicit so apps gating on them know VS Code doesn't
      // forward those notifications.
      base.hostCapabilitiesOverride = {
        openLinks: {},
        serverTools: { listChanged: false },
        serverResources: { listChanged: false },
        logging: {},
      };
      // Per-resource environment context. Inherits Cursor's editor-surface
      // shape; `containerDimensions` is a placeholder pending a VS Code
      // probe. Inline-only — VS Code renders MCP UI in the chat panel
      // without fullscreen / pip modes.
      base.hostContext = {
        theme,
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        containerDimensions: { width: 649, maxHeight: 800 },
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        userAgent: "vscode",
        platform: "desktop",
      };
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          // Base MCP protocol clientInfo. Not probed — "Visual Studio Code"
          // matches VS Code's product identity (Cursor reports the forked
          // "cursor-vscode"); refine when a live capture lands.
          clientInfo: { name: "Visual Studio Code", version: "1.105.0" },
        },
        apps: {
          uiInitialize: {
            // hostInfo sent in `ui/initialize`. Apps branching on
            // `hostInfo.name === "Visual Studio Code"` need this. Not probed.
            hostInfo: { name: "Visual Studio Code", version: "1.105.0" },
          },
          sandbox: {
            csp: {
              // Honor the view's declared CSP — no host-side restrictTo (see
              // the Claude template for the full intersection-trap rationale).
              mode: "declared",
            },
            permissions: {
              mode: "custom",
              allow: { clipboardWrite: true },
            },
          },
        },
      };
      return base;
    },
  },
  {
    id: "agentcore",
    label: "AgentCore",
    description:
      "AWS Bedrock AgentCore runtime. Text MCP servers only, no widget rendering.",
    seed: () => {
      const base = emptyHostConfigInputV2({
        // Neutral stand-in skin (MCPJam house tokens + bedrock logo). See
        // AGENTCORE_HOST_STYLE in client-styles/built-ins.ts.
        hostStyle: "agentcore",
        // AgentCore runs models on Amazon Bedrock (typically Claude).
        // Bedrock ids are BYOK (bare `us.anthropic.claude-*` strings that
        // need AWS creds), so default to the guest-allowed hosted Claude
        // analog — Haiku 4.5 — so the App Builder works without AWS
        // credentials. Users can swap to a real Bedrock model id after.
        modelId: "anthropic/claude-haiku-4.5",
        temperature: 0.7,
        requireToolApproval: false,
      });
      // AgentCore permits only text-based MCP servers — it does NOT render
      // MCP Apps widgets. Like Codex, replace `clientCapabilities` entirely
      // (rather than spreading) so the SDK-default UI extension doesn't leak
      // back in and misrepresent AgentCore as UI-capable. It still surfaces
      // elicitation for text-only interaction.
      //
      // GUESS (unprobed): kept to `elicitation` only. An agent runtime
      // plausibly also advertises `roots` and/or `sampling`, but AgentCore
      // is server-side (no local CLI to run `mcpjam-learn start-host-probe`
      // against), so we can't confirm — left off rather than invented. Add
      // them once a live AgentCore→MCP `initialize` capture is available.
      base.clientCapabilities = {
        elicitation: {},
      };
      // No rendering surface → no hostContext and no hostCapabilitiesOverride
      // (there's no ui/initialize negotiation). Leaves both as the empty
      // defaults from emptyHostConfigInputV2. Same reasoning as the Codex
      // template.
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          // GUESS (unprobed) — every value below is a best-effort placeholder
          // chosen to match AWS's product naming, NOT a live capture. Unlike
          // the Codex / Claude Code templates (which carry real
          // `start-host-probe` data here), AgentCore runs server-side so we
          // couldn't probe it locally. Replace verbatim once a real
          // AgentCore→MCP `initialize` is captured: `protocolVersion`,
          // `clientInfo.name` (the actual MCP SDK identity the agent sends —
          // may not be "bedrock-agentcore"), and `version`.
          supportedProtocolVersions: ["2025-06-18"],
          // `title` / `description` / `websiteUrl` land in the pass-through
          // `Record<string, unknown>` per host-config-v2 (backend
          // soft-validates name/version only).
          clientInfo: {
            name: "bedrock-agentcore",
            title: "AgentCore",
            version: "1.0.0",
            description: "AWS Bedrock AgentCore agent runtime",
            websiteUrl: "https://aws.amazon.com/bedrock/agentcore/",
          },
        },
      };
      return base;
    },
  },
  {
    id: "n8n",
    label: "n8n",
    description: "n8n MCP Client Tool. Tools-only client, no widget rendering.",
    seed: () => {
      const base = emptyHostConfigInputV2({
        hostStyle: "n8n",
        // n8n's MCP Client Tool is model-provider agnostic; this hosted
        // default only keeps MCPJam's simulated chat runnable out-of-the-box.
        modelId: "openai/gpt-5-nano",
        temperature: 0.7,
        requireToolApproval: false,
      });
      // Captured from a real @n8n/n8n-nodes-langchain.mcpClientTool probe:
      // it sends an empty capabilities object and no MCP UI extension. Replace
      // the SDK default entirely so the template remains tools-only.
      base.clientCapabilities = {};
      // n8n does not render MCP Apps views, so there is no ui/initialize host
      // capability negotiation, no hostContext, and no OpenAI compat runtime.
      base.hostCapabilitiesOverride = {};
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          supportedProtocolVersions: ["2025-11-25"],
          clientInfo: {
            name: "@n8n/n8n-nodes-langchain.mcpClientTool",
            version: "1.3",
          },
        },
      };
      return base;
    },
  },
  {
    id: "perplexity",
    label: "Perplexity",
    description:
      "Perplexity MCP client. Tools-only client, no widget rendering.",
    seed: () => {
      const base = emptyHostConfigInputV2({
        hostStyle: "perplexity",
        // The probe only identifies Perplexity's MCP client, not a reusable
        // model id; keep MCPJam's simulated chat runnable with a hosted model.
        modelId: "openai/gpt-5-nano",
        temperature: 0.7,
        requireToolApproval: false,
      });
      // Captured from the Perplexity host probe: protocol 2025-06-18,
      // clientInfo mcp@0.1.0, and an empty clientCapabilities object.
      base.clientCapabilities = {};
      // No snapshot/UI support in the probe, so keep this template headless.
      base.hostCapabilitiesOverride = {};
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          supportedProtocolVersions: ["2025-06-18"],
          clientInfo: { name: "mcp", version: "0.1.0" },
        },
      };
      return base;
    },
  },
  {
    id: "cline",
    label: "Cline",
    description:
      "Cline coding-agent MCP client. Tools-only client, no widget rendering.",
    seed: () => {
      const base = emptyHostConfigInputV2({
        hostStyle: "cline",
        // The probe only identifies Cline's MCP client, not a reusable model
        // id; keep MCPJam's simulated chat runnable with a hosted model.
        modelId: "anthropic/claude-haiku-4.5",
        temperature: 1.0,
        requireToolApproval: false,
      });
      // Captured from the Cline 3.89.2 host probe: protocol 2025-11-25,
      // clientInfo Cline@3.89.2, and an empty clientCapabilities object.
      base.clientCapabilities = {};
      // The probe reported no snapshot ("no-snapshot-yet") and Cline renders
      // its own native agent UI, not MCP Apps widgets — so there is no
      // ui/initialize host-capability negotiation and no hostContext.
      base.hostCapabilitiesOverride = {};
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          supportedProtocolVersions: ["2025-11-25"],
          clientInfo: { name: "Cline", version: "3.89.2" },
        },
      };
      return base;
    },
  },
  {
    id: "notion",
    label: "Notion",
    description:
      "Notion AI agent MCP client. Tools-only client, no widget rendering.",
    seed: () => {
      const base = emptyHostConfigInputV2({
        hostStyle: "notion",
        // Notion AI is model-provider agnostic toward MCP servers; this hosted
        // default only keeps MCPJam's simulated chat runnable out-of-the-box.
        modelId: "anthropic/claude-haiku-4.5",
        temperature: 1.0,
        requireToolApproval: false,
      });
      // Bare client: advertises an empty capabilities object and negotiates no
      // MCP Apps/UI extension (no `mimeTypes`). Replace the SDK default
      // entirely so nothing is layered on top.
      base.clientCapabilities = {};
      // Notion renders its own native agent UI, not MCP Apps widgets, so there
      // is no ui/initialize host-capability negotiation and no hostContext.
      base.hostCapabilitiesOverride = {};
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          supportedProtocolVersions: ["2025-11-25"],
          // NOTE: name/version are placeholders — only Notion's browser thinking
          // animation was captured, not its MCP `initialize` handshake. Swap in
          // the real clientInfo once a wire probe is available.
          clientInfo: { name: "notion", version: "1.0.0" },
        },
      };
      return base;
    },
  },
];

export const DEFAULT_HOST_TEMPLATE_ID: HostTemplateId = "mcpjam";

export function seedFromHostTemplate(
  id: HostTemplateId,
  opts?: SeedHostTemplateOptions
): SeededHostConfigInput {
  const template = HOST_TEMPLATES.find((t) => t.id === id) ?? HOST_TEMPLATES[0];
  return template.seed(opts);
}

export const seedHostTemplate = seedFromHostTemplate;
