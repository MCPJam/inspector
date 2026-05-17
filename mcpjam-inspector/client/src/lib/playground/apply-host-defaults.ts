import type { ChatboxHostStyle } from "@/lib/chatbox-host-style";
import {
  type HostConfigDtoV2,
  type HostConfigInputV2,
} from "@/lib/host-config-v2";
import {
  seedFromHostTemplate,
  type HostTemplateId,
} from "@/lib/host-templates";
import type { ChatUiOverride } from "@/lib/host-styles";
import { saveSelectedModelId } from "@/lib/selected-model-storage";
import {
  getCanonicalModelId,
  isModelSupported,
} from "@/shared/types";
import { useHostContextStore } from "@/stores/host-context-store";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";

/**
 * Subset of `HostConfigInputV2` / `HostConfigDtoV2` the playground chips
 * read. Both shapes are accepted (the relevant fields have identical
 * names and types across input and DTO).
 */
type HostConfigForPlayground = Pick<
  HostConfigInputV2,
  | "hostStyle"
  | "modelId"
  | "hostContext"
  | "mcpProfile"
  | "hostCapabilitiesOverride"
  | "chatUiOverride"
>;

/**
 * Resolve the model id to feed into the chat-composer picker.
 *
 * Accept any id that canonicalizes to a real `SUPPORTED_MODELS` entry —
 * MCPJam-provided AND BYOK. The picker decides at render time whether
 * to disable a row (e.g. BYOK without a key); silently mapping BYOK
 * ids away here is wrong for the "playground reads everything from the
 * host" contract — if the host's `modelId` is `"openai/gpt-4o"`, the
 * picker should show GPT-4o, not snap to a template default.
 *
 * Fall through to the host style's template default only when the
 * configured id is empty/whitespace or doesn't resolve at all. BYO
 * host ids with no template entry land on MCPJam, whose `modelId` is
 * empty — returns `undefined`, which the caller treats as "leave the
 * picker alone."
 */
function resolvePlaygroundModelId(
  desiredModelId: string | undefined,
  hostStyle: string,
): string | undefined {
  const trimmed = desiredModelId?.trim();
  if (trimmed) {
    const canonical = getCanonicalModelId(trimmed);
    if (isModelSupported(canonical)) return canonical;
  }
  const fallback = seedFromHostTemplate(
    hostStyle as HostTemplateId,
  ).modelId?.trim();
  if (!fallback) return undefined;
  const canonicalFallback = getCanonicalModelId(fallback);
  return isModelSupported(canonicalFallback) ? canonicalFallback : undefined;
}

/**
 * Setters the helper needs to write into the context-scoped preferences
 * store. Passed in by the caller because `usePreferencesStore` is mounted
 * as a React context provider — the helper itself isn't a hook and can't
 * call `.getState()` on it.
 */
export interface ApplyHostPlaygroundSetters {
  setHostStyle: (hostStyle: string) => void;
  setHostCapabilitiesOverride: (
    next: Record<string, unknown> | undefined,
  ) => void;
  setChatUiOverride: (next: ChatUiOverride | undefined) => void;
}

/**
 * Snapshot a host config's defaults into the playground top-bar chip state.
 *
 * The model: the playground is a sandbox; the chips display the active
 * host's defaults; users can tweak in-session for testing; tweaks are NOT
 * persisted back to the host (saving lives in the Hosts editor page).
 *
 * Two callers today:
 *   1. The brand-pill `onClick` in `HostContextHeader` —
 *      via {@link applyHostDefaultsToPlayground}, seeded from a static template.
 *   2. The named-host picker in `PlaygroundHeader` (the `HostPicker`
 *      dropdown) — via `PlaygroundPreviewedHostSync`, seeded from the
 *      project's persisted host config.
 *
 * Writes to multiple stores synchronously:
 *   - `setHostStyle(config.hostStyle)` (drives the brand-pill highlight,
 *     the loading-indicator dispatch, and any chat-v2 family-keyed visuals)
 *   - `useHostContextStore.applyHostTemplate` (locale, timezone, container,
 *      theme, deviceCapabilities — the whole hostContext blob)
 *   - `useUIPlaygroundStore.setCustomViewport` / `setDeviceType` (Device chip)
 *   - `useUIPlaygroundStore.setCspMode` + `setMcpAppsCspMode` (Permissive chip)
 *   - `setHostCapabilitiesOverride` (the bag's other callback)
 *
 * The two preferences-store setters are injected because
 * `usePreferencesStore` is context-scoped — call sites read them from the
 * hook and pass them in.
 *
 * Pure side-effect; safe to call from a user-action callback OR a
 * useEffect that runs at most once per host change. NOT safe to call
 * unconditionally on every render — fans out to multiple stores.
 */
export function applyHostConfigToPlayground(
  config: HostConfigForPlayground,
  setters: ApplyHostPlaygroundSetters,
): void {
  // Order: identity (hostStyle) first so any subscriber sees the new
  // active host before the chip stores are repainted.
  setters.setHostStyle(config.hostStyle);

  // Lead model: persist + notify any subscribed `usePersistedModel`
  // instance so the chat-composer model picker re-reads. Resolver maps
  // stale persisted ids onto the host's template default before saving;
  // returns undefined when nothing usable resolves (e.g. MCPJam host),
  // and we leave the picker alone in that case.
  const modelId = resolvePlaygroundModelId(config.modelId, config.hostStyle);
  if (modelId) {
    saveSelectedModelId(modelId);
  }

  useHostContextStore.getState().applyHostTemplate(config.hostContext ?? {});

  // Per SEP-1865, `hostContext.containerDimensions` is policy for the View
  // iframe (the MCP App widget), NOT the host's chat panel. It's already
  // delivered to Views via `ui/initialize.hostContext` (see
  // `applyHostTemplate` above). Don't project it onto the playground's
  // device-frame viewport — that shrunk the entire chat to e.g. 720px when
  // picking Claude. Keep the playground full-width; the View iframe sizes
  // itself from the hostContext.
  useUIPlaygroundStore.getState().setDeviceType("desktop");

  // Templates / configs encode their CSP intent under
  // `mcpProfile.apps.sandbox.csp.mode`; the only branded value today is
  // `"declared"`. Map that to the playground's `"widget-declared"` so the
  // Permissive chip displays correctly. Set both legacy `cspMode` and
  // `mcpAppsCspMode` because the chip's display value is chosen by the
  // active resource's protocol, not by the host alone.
  const cspMode =
    config.mcpProfile?.apps?.sandbox?.csp?.mode === "declared"
      ? "widget-declared"
      : "permissive";
  useUIPlaygroundStore.getState().setCspMode(cspMode);
  useUIPlaygroundStore.getState().setMcpAppsCspMode(cspMode);

  // `setHostCapabilitiesOverride(undefined)` clears the override and falls
  // back to the host-style preset — the desired behavior for MCPJam (and
  // any host without an explicit override).
  setters.setHostCapabilitiesOverride(config.hostCapabilitiesOverride);

  // Same shape as hostCapabilitiesOverride: undefined means "preset wins"
  // (see ChatboxChatUiOverrideContext). Snapshotting here lets the
  // playground show the host's custom logo / palette / indicator without
  // a separate provider per surface.
  setters.setChatUiOverride(config.chatUiOverride);
}

/**
 * Snapshot a host *style*'s template defaults into the playground chip
 * state. Wired to the brand-pill `onClick` in `HostContextHeader`.
 *
 * BYO custom hosts (registered client-side via `lib/host-styles` but with
 * no `host-templates.ts` entry) fall through to the MCPJam template
 * (essentially empty defaults: clears the capability override, resets the
 * device to desktop, drops to permissive CSP).
 */
export function applyHostDefaultsToPlayground(
  hostStyle: ChatboxHostStyle,
  setters: ApplyHostPlaygroundSetters,
): void {
  // `seedFromHostTemplate` is typed as `HostTemplateId` but the runtime
  // falls through to MCPJam on unknown ids. The cast keeps the call site
  // tolerant of arbitrary BYO host-style ids.
  const cfg = seedFromHostTemplate(hostStyle as HostTemplateId);
  // Override the template's `hostStyle` with the user's actual pick — for
  // BYO ids the template falls back to MCPJam, but the brand pill that
  // was clicked is the right identity to advertise.
  applyHostConfigToPlayground({ ...cfg, hostStyle }, setters);
}

// HostConfigDtoV2 happens to share the same field shape on the three
// keys we read; re-export the type alias for callers that want to be
// explicit about which surface they're feeding in.
export type { HostConfigDtoV2, HostConfigInputV2 };
