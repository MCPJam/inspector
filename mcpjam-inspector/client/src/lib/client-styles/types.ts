import type { ComponentType } from "react";
import type {
  McpUiHostCapabilities,
  McpUiStyles,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { UIType } from "@/lib/mcp-ui/mcp-apps-utils";

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
   * `HostCapabilities` by `buildHostCapabilities`. Currently used by
   * Cursor to set `serverTools.listChanged: false` /
   * `serverResources.listChanged: false` — sub-field detail the M365-grain
   * matrix doesn't model. NOT user-editable; presets carry their own
   * quirks here and the resolver applies them only to keys the matrix
   * already advertised.
   */
  hostCapabilitiesAugment?: Partial<Omit<McpUiHostCapabilities, "sandbox">>;
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
 * constraint. `selectFiles` / `setOpenInAppUrl` appear in the OpenAI
 * reference and Copilot's table; they're typed here so presets/UI can
 * express them, but the SDK runtime intentionally does NOT install them
 * as methods on `window.openai` (no-op stubs would defeat feature
 * detection — widgets that test `if (window.openai.selectFiles)` must
 * see `undefined` to take their fallback path).
 */
export type OpenAiAppsCapabilities = {
  callTool?: boolean;
  sendFollowUpMessage?: boolean;
  setWidgetState?: boolean;
  requestDisplayMode?: "all" | "fullscreen-only" | "none";
  notifyIntrinsicHeight?: boolean;
  openExternal?: boolean;
  setOpenInAppUrl?: boolean;
  requestModal?: boolean;
  uploadFile?: boolean;
  selectFiles?: boolean;
  getFileDownloadUrl?: boolean;
  requestCheckout?: boolean;
  requestClose?: boolean;
};

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

/**
 * Sibling of {@link OpenAiAppsCapabilities} for the SEP-1865 `app.*` spec
 * bridge. Sparse here — presets supply the full resolved record via
 * {@link ResolvedMcpAppsCapabilities}; user overrides on
 * `mcpProfile.apps.mcpAppsOverrides` are sparse and merge field-by-field.
 *
 * Independent from the OpenAI shim matrix. `window.openai.callTool` and
 * `app.callTool` are different surfaces representing different APIs;
 * toggling a row here does not affect the OpenAI matrix and vice versa.
 *
 * Each row corresponds to one of three lever types:
 *
 *   - **advertise** — folded into the `HostCapabilities` blob the host
 *     returns in `ui/initialize` (e.g. `serverResources`, `logging`).
 *   - **emit** — gates whether the host actually sends a notification to
 *     the View at runtime (e.g. `toolInputPartial`, `hostContextChanged`).
 *   - **behavior** — gates how the host interprets resource `_meta.ui.*`
 *     or other inbound data (e.g. `resourcePrefersBorder`).
 *
 * Row meanings:
 *
 *   - `availableDisplayModes` — host-advertised display modes via
 *     `HostContext.availableDisplayModes`. The matrix only gates the
 *     host-advertised side; the View also declares its own
 *     `appCapabilities.availableDisplayModes` in `ui/initialize` (the
 *     widget's responsibility).
 *   - `toolInputPartial` / `toolCancelled` / `hostContextChanged` /
 *     `resourceTeardown` — gate whether the host emits the corresponding
 *     `ui/notifications/*` (or `ui/resource-teardown` request) to the View.
 *   - `toolInfo` — gate the `HostContext.toolInfo` field.
 *   - `serverResources` / `logging` — gate the matching `HostCapabilities`
 *     keys. Disabling `logging` also blocks `app.sendLog()` (the
 *     `notifications/message` View → Host channel is gated by this
 *     capability per the spec).
 *   - `sandboxPermissions` / `cspFrameDomains` / `cspBaseUriDomains` —
 *     gate whether the renderer honors the matching resource `_meta.ui`
 *     sandbox sub-fields when composing the iframe sandbox.
 *   - `resourcePrefersBorder` — gate whether the renderer honors
 *     `_meta.ui.prefersBorder` when rendering the iframe chrome.
 */
export type McpAppsCapabilities = {
  /** Allow-list of display modes advertised in HostContext. */
  availableDisplayModes?: ("inline" | "fullscreen" | "pip")[];
  toolInputPartial?: boolean;
  toolCancelled?: boolean;
  hostContextChanged?: boolean;
  resourceTeardown?: boolean;
  toolInfo?: boolean;
  openLinks?: boolean;
  serverTools?: boolean;
  serverResources?: boolean;
  logging?: boolean;
  updateModelContext?: boolean;
  message?: boolean;
  sandboxPermissions?: boolean;
  cspFrameDomains?: boolean;
  cspBaseUriDomains?: boolean;
  resourcePrefersBorder?: boolean;
  /**
   * Host policy for `ui/request-display-mode` originating from the widget.
   * SEP-1865 permits the host to decline these requests; this row exposes
   * that decision as a knob.
   *   - "accept": grant the requested mode (clamped to `availableDisplayModes`)
   *   - "user-initiated-only": grant only after the user has explicitly
   *     moved off `inline` via the host picker; otherwise return `inline`
   *   - "decline": always return the current mode, ignoring the request
   */
  widgetDisplayModeRequests?: "accept" | "user-initiated-only" | "decline";
};

/**
 * Fully-resolved per-dimension matrix — preset merged with user overrides,
 * no undefineds. Returned by `resolveEffectiveMcpAppsCapabilities`.
 * `availableDisplayModes` is non-empty (resolver coerces to `["inline"]`
 * if a user override would otherwise empty it).
 *
 * `openLinks` and `serverTools` are matrix-controlled even though every
 * built-in preset turns them on — keeping them in the matrix lets
 * legacy `hostCapabilitiesOverride: {}` ("advertise nothing") survive
 * migration without silently widening the advertised surface, and lets
 * future host presets that legitimately don't advertise them
 * (e.g. minimal SEP-1865-only hosts) sit in the same shape.
 *
 * `downloadFile` advertises the host's support for the spec's
 * `ui/download-file` request. When true the renderer wires
 * `bridge.ondownloadfile` and advertises `hostCapabilities.downloadFile`
 * in the ui/initialize blob.
 *
 * `requestTeardown` advertises that the host will honor a view-initiated
 * `ui/notifications/request-teardown` by attempting a graceful
 * `ui/resource-teardown` before unmounting the iframe. The notification
 * itself is not capability-gated by SEP-1865, but the matrix row keeps
 * the per-preset behavior honest (a host that ignores the request
 * should set this false).
 */
export type ResolvedMcpAppsCapabilities = {
  availableDisplayModes: ("inline" | "fullscreen" | "pip")[];
  toolInputPartial: boolean;
  toolCancelled: boolean;
  hostContextChanged: boolean;
  resourceTeardown: boolean;
  toolInfo: boolean;
  openLinks: boolean;
  serverTools: boolean;
  serverResources: boolean;
  logging: boolean;
  updateModelContext: boolean;
  message: boolean;
  sandboxPermissions: boolean;
  cspFrameDomains: boolean;
  cspBaseUriDomains: boolean;
  resourcePrefersBorder: boolean;
  downloadFile: boolean;
  requestTeardown: boolean;
  widgetDisplayModeRequests: "accept" | "user-initiated-only" | "decline";
};

/**
 * Inspector-side chat chrome for a host style. None of this travels over
 * the MCP wire — it drives the picker, the chat shell background, the
 * loading indicator art, etc.
 *
 * The name `chatUi` deliberately mirrors the backend envelope on
 * `chatboxes.chatUi` (see `mcpjam-backend/convex/lib/chatboxUxValidators.ts`,
 * `chatUiValidator`). Backend stores per-chatbox overrides for this same
 * conceptual category; the client uses the same name for per-host defaults
 * so the vocabulary lines up across the stack. A future per-chatbox
 * indicator override would land as `chatUi.indicator: string` on the
 * chatbox row, mirroring how `chatUi.welcome` works today.
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
 * `@/lib/client-styles` and consumed by chatbox bootstrap, builder pickers,
 * shell theming, and the MCP Apps iframe bridge.
 *
 * Adding a new built-in host is a matter of authoring `mcp` + `chatUi`
 * objects and registering them; future project-defined hosts can use the
 * same shape once a scoped host layer exists.
 *
 * Only `id` is persisted to the DB (as `'claude' | 'chatgpt' | 'direct'`
 * on `hostConfigs.hostStyle` / `chatboxes.hostStyle`); both `mcp` and
 * `chatUi` are reconstituted client-side from the id at runtime.
 */
export interface HostStyleDefinition {
  id: HostStyleId;
  mcp: HostMcpProfile;
  chatUi: HostChatUi;
}
