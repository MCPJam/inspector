import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/host-config-v2";
import {
  MCPJAM_FONT_CSS,
  MCPJAM_PLATFORM,
  getMcpJamStyleVariables,
} from "@/config/mcpjam-host-context";
import mcpjamLogo from "/mcp_jam.svg";
import claudeLogo from "/claude_logo.png";
import openaiLogo from "/openai_logo.png";
import cursorLogo from "/cursor_logo.png";
import codexLogo from "/codex-logo.svg";

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

// @font-face block claude.ai injects via hostContext.styles.css.fonts. URL
// hosts must be allowed in apps.sandbox.csp.resourceDomains (assets.claude.ai)
// for these to actually load inside the View iframe.
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
  | "codex";

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
        availableDisplayModes: ["inline", "fullscreen"],
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
        requireToolApproval: false,
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
              mode: "declared",
              restrictTo: {
                connectDomains: [
                  "https://api.openai.com",
                  "https://api.anthropic.com",
                  "https://cdn.jsdelivr.net",
                ],
                // claude.ai *advertises* only cdn.jsdelivr.net in
                // hostCapabilities.sandbox.csp.resourceDomains but the
                // *enforced* sandbox URL adds assets.claude.ai so the
                // Anthropic Sans @font-face URLs above can load. We
                // honor the enforced set; otherwise fonts 404 inside the
                // sandbox.
                resourceDomains: [
                  "https://cdn.jsdelivr.net",
                  "https://assets.claude.ai",
                ],
              },
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
      // hostCapabilities override: captured verbatim from a Cursor 3.4.17
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
        containerDimensions: { width: 748, maxHeight: 800 },
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
            hostInfo: { name: "Cursor", version: "3.4.17" },
          },
          sandbox: {
            csp: {
              // `restrictTo` matches the CSP Cursor's webview actually
              // installs (verified from the probe's `policies.metaCsp`).
              // `mode: "declared"` keeps each resource's own CSP
              // authoritative; we only intersect on top.
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
    description: "OpenAI Codex CLI. Terminal client — elicitation only, no UI.",
    logoSrc: codexLogo,
    seed: () => {
      const base = emptyHostConfigInputV2({
        // Codex doesn't render an iframe chrome of its own; borrow the
        // OpenAI visual family for any in-inspector chat preview. If/when
        // we add a dedicated codex HostStyleDefinition, swap this to "codex".
        hostStyle: "chatgpt",
        // Codex defaults to GPT-5; pick the smallest variant that's in
        // MCPJAM_GUEST_ALLOWED_MODEL_IDS so guests can use the template
        // without an OpenAI key.
        modelId: "openai/gpt-5-nano",
        temperature: 0.7,
        requireToolApproval: false,
      });
      // clientCapabilities: real codex-mcp-client publishes ONLY
      // `elicitation` — no MCP UI extension, no roots, no sampling.
      // Replace the SDK-default block (which seeds the UI extension)
      // outright; merging would re-introduce capabilities Codex doesn't
      // actually advertise.
      base.clientCapabilities = {
        elicitation: {},
      };
      // Codex is a CLI — no iframe, no widgets, nothing to advertise on
      // the host side. An empty override means "advertise nothing" rather
      // than inheriting the chatgpt preset's openLinks/serverTools/etc.
      base.hostCapabilitiesOverride = {};
      // No hostContext: a terminal client doesn't expose theme,
      // displayMode, containerDimensions, or fonts.
      base.hostContext = {};
      base.mcpProfile = {
        profileVersion: 1,
        initialize: {
          // clientInfo verbatim from a real codex-mcp-client initialize
          // request. `title` is non-standard but preserved as-is; the
          // backend passes the clientInfo record through unchanged.
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
];

export const DEFAULT_HOST_TEMPLATE_ID: HostTemplateId = "mcpjam";

export function seedFromHostTemplate(id: HostTemplateId): HostConfigInputV2 {
  const template =
    HOST_TEMPLATES.find((t) => t.id === id) ?? HOST_TEMPLATES[0];
  return template.seed();
}
