import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import type { HostThemeMode } from "@/lib/client-styles";
import {
  MCPJAM_FONT_CSS,
  MCPJAM_PLATFORM,
  getMcpJamStyleVariables,
} from "@/config/mcpjam-client-context";
import mcpjamLogo from "/mcp_jam.svg";
import claudeLogo from "/claude_logo.png";
import openaiLogo from "/openai_logo.png";
import cursorLogo from "/cursor_logo.png";
import vscodeLogo from "/vscode_logo.svg";
import codexLogo from "/codex-logo.svg";
import copilotLogo from "/copilot_logo.png";

declare const __APP_VERSION__: string;

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

// Verbatim from a real Visual Studio Code 1.121.0 host probe
// (hostContext.styles.variables). Every token is an indirection into VS
// Code's own theme vars (`var(--vscode-*)`), so it renders faithfully
// inside a real VS Code webview. CAVEAT: those `--vscode-*` vars don't
// exist in MCPJam's renderer, so a widget's VS-Code-themed colors won't
// resolve here. To make them render in the inspector too, add hex
// fallbacks (e.g. `var(--vscode-editor-background, #1e1e1e)`) from VS
// Code's Default Dark Modern theme — still faithful in real VS Code, which
// ignores the fallback.
const VSCODE_HOST_STYLE_VARIABLES: Record<string, string> = {
  "--color-background-primary": "var(--vscode-editor-background)",
  "--color-background-secondary": "var(--vscode-sideBar-background)",
  "--color-background-tertiary": "var(--vscode-activityBar-background)",
  "--color-background-inverse": "var(--vscode-editor-foreground)",
  "--color-background-ghost": "transparent",
  "--color-background-info": "var(--vscode-inputValidation-infoBackground)",
  "--color-background-danger": "var(--vscode-inputValidation-errorBackground)",
  "--color-background-success": "var(--vscode-diffEditor-insertedTextBackground)",
  "--color-background-warning": "var(--vscode-inputValidation-warningBackground)",
  "--color-background-disabled": "var(--vscode-editor-inactiveSelectionBackground)",
  "--color-text-primary": "var(--vscode-foreground)",
  "--color-text-secondary": "var(--vscode-descriptionForeground)",
  "--color-text-tertiary": "var(--vscode-disabledForeground)",
  "--color-text-inverse": "var(--vscode-editor-background)",
  "--color-text-ghost": "var(--vscode-descriptionForeground)",
  "--color-text-info": "var(--vscode-textLink-foreground)",
  "--color-text-danger": "var(--vscode-errorForeground)",
  "--color-text-success": "var(--vscode-testing-iconPassed)",
  "--color-text-warning": "var(--vscode-editorWarning-foreground)",
  "--color-text-disabled": "var(--vscode-disabledForeground)",
  "--color-border-primary": "var(--vscode-widget-border)",
  "--color-border-secondary": "var(--vscode-editorWidget-border)",
  "--color-border-tertiary": "var(--vscode-panel-border)",
  "--color-border-inverse": "var(--vscode-foreground)",
  "--color-border-ghost": "transparent",
  "--color-border-info": "var(--vscode-inputValidation-infoBorder)",
  "--color-border-danger": "var(--vscode-inputValidation-errorBorder)",
  "--color-border-success": "var(--vscode-testing-iconPassed)",
  "--color-border-warning": "var(--vscode-inputValidation-warningBorder)",
  "--color-border-disabled": "var(--vscode-disabledForeground)",
  "--color-ring-primary": "var(--vscode-focusBorder)",
  "--color-ring-secondary": "var(--vscode-focusBorder)",
  "--color-ring-inverse": "var(--vscode-focusBorder)",
  "--color-ring-info": "var(--vscode-inputValidation-infoBorder)",
  "--color-ring-danger": "var(--vscode-inputValidation-errorBorder)",
  "--color-ring-success": "var(--vscode-testing-iconPassed)",
  "--color-ring-warning": "var(--vscode-inputValidation-warningBorder)",
  "--font-sans": "var(--vscode-font-family)",
  "--font-mono": "var(--vscode-editor-font-family)",
  "--font-weight-normal": "normal",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "bold",
  "--font-text-xs-size": "10px",
  "--font-text-sm-size": "11px",
  "--font-text-md-size": "13px",
  "--font-text-lg-size": "14px",
  "--font-heading-xs-size": "16px",
  "--font-heading-sm-size": "18px",
  "--font-heading-md-size": "20px",
  "--font-heading-lg-size": "24px",
  "--font-heading-xl-size": "32px",
  "--font-heading-2xl-size": "40px",
  "--font-heading-3xl-size": "48px",
  "--font-text-xs-line-height": "1.5",
  "--font-text-sm-line-height": "1.5",
  "--font-text-md-line-height": "1.5",
  "--font-text-lg-line-height": "1.5",
  "--font-heading-xs-line-height": "1.25",
  "--font-heading-sm-line-height": "1.25",
  "--font-heading-md-line-height": "1.25",
  "--font-heading-lg-line-height": "1.25",
  "--font-heading-xl-line-height": "1.25",
  "--font-heading-2xl-line-height": "1.25",
  "--font-heading-3xl-line-height": "1.25",
  "--border-radius-xs": "2px",
  "--border-radius-sm": "3px",
  "--border-radius-md": "4px",
  "--border-radius-lg": "6px",
  "--border-radius-xl": "8px",
  "--border-radius-full": "9999px",
  "--border-width-regular": "1px",
  "--shadow-hairline": "0 0 0 1px var(--vscode-widget-shadow)",
  "--shadow-sm": "0 1px 2px 0 var(--vscode-widget-shadow)",
  "--shadow-md": "0 4px 6px -1px var(--vscode-widget-shadow)",
  "--shadow-lg": "0 10px 15px -3px var(--vscode-widget-shadow)",
};

export type HostTemplateId =
  | "mcpjam"
  | "claude"
  | "chatgpt"
  | "cursor"
  | "vscode"
  | "codex"
  | "copilot";

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
}

const DEFAULT_SEED_THEME: HostThemeMode = "dark";

export interface HostTemplate {
  id: HostTemplateId;
  label: string;
  description: string;
  logoSrc: string;
  seed: (opts?: SeedHostTemplateOptions) => HostConfigInputV2;
}

export const HOST_TEMPLATES: readonly HostTemplate[] = [
  {
    id: "mcpjam",
    label: "MCPJam",
    description: "SDK defaults. Pick a model later.",
    logoSrc: mcpjamLogo,
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
      // `__APP_VERSION__` is the same Vite build constant
      // mcp-apps-renderer.tsx uses for hostInfo.version, so the
      // inspector's MCP-side and Apps-side identities stay in lockstep.
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          clientInfo: { name: "mcpjam-inspector", version: __APP_VERSION__ },
        },
        apps: {
          // MCP Apps extension: hostInfo sent to the View iframe in
          // `ui/initialize`. Views that branch on hostInfo.name === "MCPJam"
          // (e.g. dev-tool-aware widgets) need this to identify the host.
          uiInitialize: {
            hostInfo: { name: "MCPJam", version: __APP_VERSION__ },
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
    logoSrc: claudeLogo,
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
    id: "chatgpt",
    label: "ChatGPT",
    description: "OpenAI-style host with ChatGPT protocol.",
    logoSrc: openaiLogo,
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
    id: "cursor",
    label: "Cursor",
    description: "Cursor IDE chat panel. MCP UI extension on, no message/updateModelContext.",
    logoSrc: cursorLogo,
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
    id: "vscode",
    label: "VS Code",
    description: "VS Code chat panel. MCP Apps host, no window.openai.",
    logoSrc: vscodeLogo,
    seed: (opts) => {
      const base = emptyHostConfigInputV2({
        hostStyle: "vscode",
        // Canonical id (anthropic/<slug>) so the chat-composer model picker
        // resolves it. VS Code's chat is model-agnostic (you pick); Sonnet
        // 4.5 is in MCPJAM_GUEST_ALLOWED_MODEL_IDS so guests get it without
        // an Anthropic key, and it mirrors the Cursor sibling default.
        modelId: "anthropic/claude-sonnet-4.5",
        temperature: 0.7,
        requireToolApproval: false,
      });
      const theme = opts?.theme ?? DEFAULT_SEED_THEME;
      // clientCapabilities: verbatim from a VS Code 1.121.0 probe. Keep the
      // SDK-default MCP UI extension entry (mimeTypes) and layer VS Code's
      // roots / sampling / elicitation / tasks declarations on top.
      base.clientCapabilities = {
        ...base.clientCapabilities,
        roots: { listChanged: true },
        sampling: {},
        elicitation: { form: {}, url: {} },
        tasks: {
          list: {},
          cancel: {},
          requests: {
            sampling: { createMessage: {} },
            elicitation: { create: {} },
          },
        },
      };
      // hostCapabilities override: captured verbatim from the probe's
      // ui/initialize. `sandbox` is intentionally omitted — the
      // canonicalizer strips it from the override (sandbox is per-resource
      // at runtime per SEP-1865; see mcpProfile.apps.sandbox below). Notably
      // no `message`: VS Code exposes no widget→model message channel.
      base.hostCapabilitiesOverride = {
        openLinks: {},
        serverTools: { listChanged: true },
        serverResources: { listChanged: true },
        logging: {},
        updateModelContext: {
          audio: {},
          image: {},
          resourceLink: {},
          resource: {},
          structuredContent: {},
        },
        downloadFile: {},
      };
      // Per-resource environment context VS Code exposes to MCP apps.
      // `containerDimensions` from the probe (maxHeight 804.75 rounded to
      // 805). `availableDisplayModes` is inline-only — VS Code renders the
      // chat-output webview inline (no fullscreen / pip). `styles.variables`
      // is VS Code's faithful `var(--vscode-*)` token map (see
      // VSCODE_HOST_STYLE_VARIABLES and its caveat above).
      base.hostContext = {
        theme,
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        containerDimensions: { width: 910, maxHeight: 805 },
        locale: "en-US",
        platform: "desktop",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.121.0 Chrome/142.0.7444.265 Electron/39.8.8 Safari/537.36",
        deviceCapabilities: { touch: false, hover: true },
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        styles: { variables: VSCODE_HOST_STYLE_VARIABLES },
      };
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          // Base MCP protocol: clientInfo sent to MCP servers during
          // `initialize`. Matches VS Code's outer-editor identity.
          clientInfo: { name: "Visual Studio Code", version: "1.121.0" },
        },
        apps: {
          // MCP Apps extension: hostInfo sent to the View iframe in
          // `ui/initialize`. Apps that branch on
          // `hostInfo.name === "Visual Studio Code"` need this to take that
          // path.
          uiInitialize: {
            hostInfo: { name: "Visual Studio Code", version: "1.121.0" },
          },
          // No compatRuntime — VS Code is a pure MCP Apps host (the probe's
          // window.openai surface is absent), unlike ChatGPT / Copilot.
          sandbox: {
            csp: {
              // No host-side `restrictTo` — see the Claude template for the
              // full rationale (SEP-1865 makes restrictTo an intersection,
              // so mirroring VS Code's allowlist only narrows a widget's
              // declared CSP). cspDirectives below are union-merged
              // (grant-only) and captured verbatim from the probe meta CSP.
              mode: "declared",
              cspDirectives: {
                "script-src": [
                  "'self'",
                  "'unsafe-inline'",
                  "https://cdn.jsdelivr.net",
                ],
                "style-src": [
                  "'self'",
                  "'unsafe-inline'",
                  "https://cdn.jsdelivr.net",
                ],
                "connect-src": [
                  "'self'",
                  "https://api.openai.com",
                  "https://api.anthropic.com",
                  "https://cdn.jsdelivr.net",
                ],
                "img-src": ["'self'", "data:", "https://cdn.jsdelivr.net"],
                "font-src": ["'self'", "https://cdn.jsdelivr.net"],
                "media-src": ["'self'", "data:", "https://cdn.jsdelivr.net"],
                "frame-src": ["'none'"],
                "object-src": ["'none'"],
                "base-uri": ["'self'"],
              },
            },
            permissions: {
              // Probe outer-iframe `allow=` grants clipboard-write (+ read);
              // clipboardWrite is the SEP-1865 permission modeled here.
              mode: "custom",
              allow: { clipboardWrite: true },
            },
            // Probe frame.sandboxAttr extras beyond the spec-mandated
            // allow-scripts / allow-same-origin.
            sandboxAttrs: [
              "allow-forms",
              "allow-downloads",
              "allow-pointer-lock",
            ],
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
    logoSrc: codexLogo,
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
    logoSrc: copilotLogo,
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
];

export const DEFAULT_HOST_TEMPLATE_ID: HostTemplateId = "mcpjam";

export function seedFromHostTemplate(
  id: HostTemplateId,
  opts?: SeedHostTemplateOptions,
): HostConfigInputV2 {
  const template =
    HOST_TEMPLATES.find((t) => t.id === id) ?? HOST_TEMPLATES[0];
  return template.seed(opts);
}
