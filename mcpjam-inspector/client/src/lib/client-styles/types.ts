import type { ComponentType } from "react";
import type {
  McpUiHostCapabilities,
  McpUiStyles,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import type { InjectedOpenAiCompatCapabilities } from "@/shared/widget-snapshot";
import type { ResolvedMcpAppsCapabilities } from "@/shared/host-style-capabilities";

/**
 * Persistable shape for a custom loading indicator. Built-in hosts ship
 * bespoke React components (Claude's morphing strip, ChatGPT's dot, etc.);
 * this is the data-shape an end user can declare on a host config without
 * writing code, rendered by `<HostIndicatorDispatch>`.
 *
 * Keep this set minimal — adding new variants requires updating the
 * dispatcher, the override editor, and the backend validator. The current
 * pair covers "branded color dots" and "user-supplied image".
 */
export type IndicatorDef =
  | {
      kind: "dots";
      /** CSS color (hex/rgb/oklch/var). Defaults to MCPJam orange. */
      color?: string;
      /** 1–3 dots. Defaults to 3. */
      count?: 1 | 2 | 3;
    }
  | {
      kind: "image";
      /** Absolute or relative URL to the indicator image. */
      src: string;
      /** Animation applied to the image; defaults to "pulse". */
      animation?: "spin" | "pulse" | "none";
    };

/**
 * Persistable chat-UI override stored on `HostConfigInputV2.chatUiOverride`.
 * Every field is optional — undefined values inherit from the preset
 * resolved by the host config's `hostStyle` (claude | chatgpt | cursor |
 * mcpjam). Mirrors the {@link HostChatUi} shape but with these differences:
 *
 * - `resolveChatBackground(theme)` → flat `chatBackground: { light, dark }`
 * - `loadingIndicator: ComponentType` → data-shape `indicator: IndicatorDef`
 *
 * The resolver in `registry.ts` (`resolveEffectiveHostStyle`) merges this
 * into a fully-resolved `HostStyleDefinition` so consumers stay unchanged.
 *
 * **Family is a discriminator, not a free string.** Custom hosts pick
 * `"claude"` or `"chatgpt"` at create-time to inherit one of the two
 * chat-v2 visual languages (bubble shapes, send hints, animation timing).
 * Flattening family into per-host CSS tokens is intentionally deferred.
 */
export interface ChatUiOverride {
  label?: string;
  shortLabel?: string;
  pickerDescription?: string;
  logoSrc?: string;
  family?: HostStyleFamily;
  chatBackground?: { light: string; dark: string };
  /**
   * MCP Apps style variables passed to the View iframe in `ui/initialize`.
   * When supplied, the override replaces the preset's full variable map
   * for the matching theme — partial maps are NOT merged with the preset
   * (avoids subtle "half a palette" rendering).
   */
  styleVariables?: { light: McpUiStyles; dark: McpUiStyles };
  indicator?: IndicatorDef;
  /** Inline @font-face / @import CSS injected into the View iframe. */
  fontCss?: string;
}

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
 * Sandbox is intentionally excluded from the preset — sandbox CSP/permissions
 * are resource-derived at runtime per SEP-1865, not a static vendor trait.
 * The renderer composes sandbox separately via `resolveSandboxCsp` /
 * `resolveSandboxPermissions` and adds it onto the advertised
 * `HostCapabilities` blob before passing to AppBridge.
 */
export interface HostMcpProfile {
  /** MCP-Apps UIType the host emulates inside chat widgets. */
  protocolOverride: UIType;
  /** Platform string passed to the MCP Apps bridge. */
  platform: "web" | "desktop" | "mobile";
  /**
   * Per-dimension capability matrix the host advertises and honors for the
   * SEP-1865 `app.*` spec bridge. Replaces an earlier flat
   * `hostCapabilities` blob — the matrix is the single source of truth and
   * `buildHostCapabilities(resolvedMatrix)` derives the wire blob.
   *
   * Typed as the fully-resolved record (not the sparse user-override type)
   * because presets are the *baseline* — leaving a field undefined would
   * force the resolver to invent a value, masking the difference between
   * "preset claims false" and "preset forgot to mention this dimension".
   *
   * Mirrors Microsoft 365 Copilot's published table (Component bridge
   * section on
   * https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-mcp-apps)
   * row-by-row for the Copilot preset; ChatGPT/Claude/Cursor/Codex/MCPJam
   * advertise the full surface.
   */
  mcpAppsCapabilities: ResolvedMcpAppsCapabilities;
  /**
   * Preset-only advertisement nuances merged into the matrix-derived
   * `HostCapabilities` by `buildHostCapabilities`. Used for sub-field detail
   * the M365-grain matrix doesn't model, such as Cursor/VS Code listChanged
   * values. NOT user-editable; presets carry their own quirks here and the
   * resolver applies them only to keys the matrix already advertised.
   */
  hostCapabilitiesAugment?: Partial<Omit<McpUiHostCapabilities, "sandbox">>;
  /**
   * Preset-only exact replacements applied after `hostCapabilitiesAugment`.
   * Use when a host advertises a typed sub-capability set that must replace,
   * rather than extend, the matrix-derived default (for example VS Code's
   * updateModelContext set, which deliberately omits `text`).
   */
  hostCapabilitiesReplacement?: Partial<Omit<McpUiHostCapabilities, "sandbox">>;
  resolveStyleVariables: (theme: HostThemeMode) => McpUiStyles;
  /** Inline @font-face / @import CSS injected into MCP App iframes. */
  fontCss: string;
  /**
   * Vendor compat-runtime shims this preset expects the inspector to
   * inject into widget HTML before sandboxing. Claude/Cursor/Codex-style
   * hosts leave this undefined or set everything to `false`; ChatGPT/
   * Copilot and MCPJam's dev surface flip the relevant shim on. End
   * users override per host config via
   * `mcpProfile.apps.compatRuntime`. Read through
   * `getCompatRuntimeForStyle` so undefined → `{ injected: false }`.
   */
  compatRuntime?: {
    /** Inject the OpenAI Apps SDK `window.openai` shim. */
    openaiApps?: boolean;
    /**
     * Per-method `window.openai.*` surface this host's preset advertises
     * when `openaiApps` is true. Optional; absent → the FULL ChatGPT
     * surface (see `OPENAI_APPS_FULL_SURFACE` in `built-ins.ts`). Hosts
     * like Microsoft 365 Copilot which expose only a subset point at a
     * dedicated constant (`OPENAI_APPS_COPILOT_SURFACE`).
     *
     * Typed as the fully-resolved record (not the sparse type used for
     * user overrides) because presets are the *baseline* — leaving a
     * field undefined here would force the resolver to invent a value,
     * masking the difference between "preset claims false" and "preset
     * forgot to mention this method".
     */
    openaiAppsCapabilities?: ResolvedOpenAiAppsCapabilities;
  };
}

/**
 * Per-method capability surface for the `window.openai` shim injected into
 * widget HTML by `injectOpenAICompat`. Sparse here (every field optional)
 * — presets supply the full record, user overrides on
 * `mcpProfile.apps.compatRuntime.openaiAppsOverrides` are sparse and merge
 * field-by-field over the preset.
 *
 * The shape mirrors Microsoft 365 Copilot's published per-method matrix
 * (Component bridge table on
 * https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-mcp-apps).
 * `requestDisplayMode` is tri-state to model Copilot's "fullscreen only"
 * constraint. `selectFiles` appears in the OpenAI reference and
 * Copilot's table; it's typed here so presets/UI can express it, but
 * the SDK runtime intentionally does NOT install it as a method on
 * `window.openai` yet (no-op stubs would defeat feature detection —
 * widgets that test `if (window.openai.selectFiles)` must see
 * `undefined` to take their fallback path). `setOpenInAppUrl` is typed
 * and implemented by the OpenAI-compatible runtime.
 *
 * Re-exports the wire-shape definition from `shared/widget-snapshot.ts`
 * (`InjectedOpenAiCompatCapabilities`) so client + server agree on a
 * single structural type. The local `OpenAiAppsCapabilities` name is
 * preserved for client-side call sites that group the matrix by app type.
 */
export type OpenAiAppsCapabilities = InjectedOpenAiCompatCapabilities;

/**
 * Fully-resolved per-method surface — preset merged with user overrides,
 * no undefineds. Returned by `getCompatRuntimeForStyle` and
 * `resolveEffectiveCompatRuntime` in the `injected: true` branch so
 * downstream consumers never need to think about field absence.
 */
export type ResolvedOpenAiAppsCapabilities = Required<OpenAiAppsCapabilities>;

/**
 * Result of resolving the compat-runtime preset/override stack for a host
 * config. Sum-typed so consumers can't accidentally read per-method caps
 * when the shim isn't being injected — `EffectiveCompatRuntime.injected`
 * is the only switch that gates the others.
 *
 * `{ injected: false }` means the inspector does NOT add the `window.openai`
 * shim to widget HTML; widgets feature-detecting on `typeof window.openai`
 * see the global as undefined, which matches what SEP-1865-only hosts
 * (Claude, Cursor, Codex) advertise.
 */
export type EffectiveCompatRuntime =
  | { injected: false }
  | { injected: true; capabilities: ResolvedOpenAiAppsCapabilities };

export type {
  McpAppsCspConnectDomains,
  McpAppsCspResourceDomains,
  McpAppsToolResultPolicy,
  McpAppsCapabilities,
  ResolvedMcpAppsCapabilities,
} from "@/shared/host-style-capabilities";

/**
 * Inspector-side chat chrome for a host style. None of this travels over
 * the MCP wire — it drives the picker, the chat shell background, the
 * loading indicator art, etc.
 *
 * The name `chatUi` deliberately mirrors the backend envelope on
 * `scenarios.chatUi` (see `mcpjam-backend/convex/lib/scenarioUxValidators.ts`,
 * `chatUiValidator`). Backend stores per-scenario overrides for this same
 * conceptual category; the client uses the same name for per-host defaults
 * so the vocabulary lines up across the stack. A future per-scenario
 * indicator override would land as `chatUi.indicator: string` on the
 * scenario row, mirroring how `chatUi.welcome` works today.
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
  /** Optional theme-specific brand logos; `logoSrc` remains the default. */
  logoSrcByTheme?: Record<HostThemeMode, string>;
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
 * `@/lib/client-styles` and consumed by scenario bootstrap, builder pickers,
 * shell theming, and the MCP Apps iframe bridge.
 *
 * Adding a new built-in host is a matter of authoring `mcp` + `chatUi`
 * objects and registering them; future project-defined hosts can use the
 * same shape once a scoped host layer exists.
 *
 * Only `id` is persisted to the DB (as `'claude' | 'chatgpt' | 'direct'`
 * on `hostConfigs.hostStyle` / `scenarios.hostStyle`); both `mcp` and
 * `chatUi` are reconstituted client-side from the id at runtime.
 */
export interface HostStyleDefinition {
  id: HostStyleId;
  mcp: HostMcpProfile;
  chatUi: HostChatUi;
}
