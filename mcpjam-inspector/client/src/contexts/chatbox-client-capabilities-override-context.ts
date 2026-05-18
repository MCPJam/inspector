import { createContext, useContext } from "react";

/**
 * Per-scope user override for the MCP Apps `hostCapabilities` blob advertised
 * in the `ui/initialize` response.
 *
 * Mirrors the shape of {@link chatbox-host-style-context}: a single Provider
 * sets the value for whatever scope owns the host config (chatbox, eval suite,
 * direct chat). The renderer reads via {@link useChatboxHostCapabilitiesOverride}
 * and falls back to the active host style's preset when this returns
 * `undefined`.
 *
 * Storing the override here — rather than in the host-context store — keeps
 * the two concerns separate: `hostContext` is per-resource environment data
 * passed into ui/initialize; `hostCapabilitiesOverride` is a vendor-trait
 * customization of the static contract the host advertises.
 */
const ChatboxHostCapabilitiesOverrideContext = createContext<
  Record<string, unknown> | undefined
>(undefined);

export const ChatboxHostCapabilitiesOverrideProvider =
  ChatboxHostCapabilitiesOverrideContext.Provider;

export function useChatboxHostCapabilitiesOverride():
  | Record<string, unknown>
  | undefined {
  return useContext(ChatboxHostCapabilitiesOverrideContext);
}
