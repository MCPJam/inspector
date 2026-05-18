import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import {
  MCPJAM_FONT_CSS,
  MCPJAM_PLATFORM,
  getMcpJamStyleVariables,
} from "@/config/mcpjam-client-context";
import mcpjamLogo from "/mcp_jam.svg";
import claudeLogo from "/claude_logo.png";
import openaiLogo from "/openai_logo.png";
import cursorLogo from "/cursor_logo.png";
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

export type HostTemplateId =
  | "mcpjam"
  | "claude"
  | "chatgpt"
  | "cursor"
  | "codex"
  | "copilot";

export interface HostTemplate {
  id: HostTemplateId;
  label: string;
  description: string;
  logoSrc: string;
  seed: () => HostConfigInputV2;
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
    seed: () => {
      const base = emptyHostConfigInputV2({ hostStyle: "mcpjam" });
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
      // surfaces/text/border tokens as the inspector itself. Theme is
      // resolved to "dark" here because the template hardcodes `theme:
      // "dark"` below; switching theme requires re-seeding.
      // MCPJAM_FONT_CSS is empty (system font stack, no @font-face), so
      // `styles.css` is omitted entirely.
      base.hostContext = {
        theme: "dark",
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
          variables: getMcpJamStyleVariables("dark"),
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
    description: "Anthropic-style host. Tool approval on.",
    logoSrc: claudeLogo,
    seed: () => {
      const base = emptyHostConfigInputV2({
        hostStyle: "claude",
        // Canonical id (anthropic/<slug>) so the chat-composer model
        // picker resolves it. Bare "claude-sonnet-4-5" never matched a
        // SUPPORTED_MODELS entry → silently fell back to default.
        // Haiku 4.5 is in MCPJAM_GUEST_ALLOWED_MODEL_IDS, so guests
        // pick it without an Anthropic key.
        modelId: "anthropic/claude-haiku-4.5",
        temperature: 1.0,
        requireToolApproval: true,
      });
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
        theme: "dark",
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
        // (set below).
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
    id: "chatgpt",
    label: "ChatGPT",
    description: "OpenAI-style host with ChatGPT protocol.",
    logoSrc: openaiLogo,
    seed: () => {
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
        theme: "dark",
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
          sandbox: {
            csp: {
              // No host-side `restrictTo` — see the Claude template for
              // the full rationale. Real ChatGPT does ship the same
              // captured allowlist (anthropic / openai / jsdelivr), but
              // mirroring it here only narrows the view's declared CSP
              // (intersection trap) and silently breaks widgets reaching
              // any other origin. The view's declaration is authoritative.
              mode: "declared",
            },
            permissions: {
              mode: "custom",
              allow: { microphone: true },
            },
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
    seed: () => {
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
      });
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
        theme: "dark",
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
    seed: () => {
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
      // Per-resource environment context. `containerDimensions` mirrors
      // ChatGPT's "fill your container" intent (md breakpoint width
      // policy, modest fixed height). `availableDisplayModes` is kept as
      // ["inline", "fullscreen"] because omitting it falls back to the
      // inspector default ["inline", "pip", "fullscreen"], which would
      // claim `pip` support Copilot doesn't have — a worse lie than the
      // known minor gap that Microsoft's docs mark
      // `app.getHostContext()?.availableDisplayModes` as ❌ (Copilot
      // widgets can't actually introspect this field on the real host).
      base.hostContext = {
        theme: "dark",
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions: { height: 400, maxWidth: 768 },
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        userAgent: "ms-copilot",
        platform: "desktop",
        deviceCapabilities: { touch: false, hover: true },
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      };
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          // Base MCP protocol: clientInfo sent during MCP `initialize`.
          // Matches Microsoft's "ms-copilot" identity convention.
          clientInfo: { name: "ms-copilot", version: "1.0.0" },
        },
        apps: {
          uiInitialize: {
            // MCP Apps extension: hostInfo sent in `ui/initialize`. Apps
            // that branch on `hostInfo.name === "Copilot"` need this to
            // take that path.
            hostInfo: { name: "Copilot", version: "1.0.0" },
          },
          sandbox: {
            csp: {
              // No host-side `restrictTo` — see the Claude template for
              // the full rationale. Real Copilot publishes its own
              // allowlist (AI APIs + jsDelivr + Microsoft Graph + Office
              // CDN), but mirroring it here would only narrow the view's
              // declared CSP via the SEP-1865 intersection rule and
              // silently break widgets reaching anything else.
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
];

export const DEFAULT_HOST_TEMPLATE_ID: HostTemplateId = "mcpjam";

export function seedFromHostTemplate(id: HostTemplateId): HostConfigInputV2 {
  const template =
    HOST_TEMPLATES.find((t) => t.id === id) ?? HOST_TEMPLATES[0];
  return template.seed();
}
