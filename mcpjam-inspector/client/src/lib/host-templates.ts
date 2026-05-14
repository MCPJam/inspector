import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/host-config-v2";
import mcpjamLogo from "/mcp_jam.svg";
import claudeLogo from "/claude_logo.png";
import openaiLogo from "/openai_logo.png";

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

export type HostTemplateId = "mcpjam" | "claude" | "chatgpt";

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
    seed: () => emptyHostConfigInputV2(),
  },
  {
    id: "claude",
    label: "Claude",
    description: "Anthropic-style host. Tool approval on.",
    logoSrc: claudeLogo,
    seed: () => {
      const base = emptyHostConfigInputV2({
        hostStyle: "claude",
        modelId: "claude-sonnet-4-5",
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
      // Skips `toolInfo` (per-invocation) and `containerDimensions`
      // (claude.ai pins width: 720 / maxHeight: 5000, but pinning here
      // would lie to apps about the inspector's actual viewport width).
      base.hostContext = {
        theme: "dark",
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen"],
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
        modelId: "gpt-5",
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
      // `toolInfo` (per-invocation) and `containerDimensions` (measured at
      // resource mount); both are filled at runtime, not config time.
      base.hostContext = {
        theme: "dark",
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen", "pip"],
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
];

export const DEFAULT_HOST_TEMPLATE_ID: HostTemplateId = "mcpjam";

export function seedFromHostTemplate(id: HostTemplateId): HostConfigInputV2 {
  const template =
    HOST_TEMPLATES.find((t) => t.id === id) ?? HOST_TEMPLATES[0];
  return template.seed();
}
