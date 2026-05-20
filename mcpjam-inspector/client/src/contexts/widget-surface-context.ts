import { createContext, useContext } from "react";

/**
 * Identifies which inspector surface is rendering the current widget
 * subtree. Used by the MCP-Apps / ChatGPT-Apps renderers to resolve
 * `cspMode` synchronously on the first render — replacing a prior
 * global-store flag (`isPlaygroundActive`) that was set in a passive
 * `useEffect` and caused the iframe's fetch-source key to flip on
 * commit #2, tearing down a healthy iframe and dropping View state
 * (the "draw a cat, then it vanishes" bug).
 *
 * `"chat"` is the default. Surfaces that aren't Playground (Connect →
 * Chat, eval suite editors, replay) inherit it and keep the existing
 * strict `"widget-declared"` CSP behavior, unchanged. Chatbox surface
 * is a separate dimension and stays on `useIsChatboxSurface()`.
 */
export type WidgetSurface = "playground" | "chat";

const WidgetSurfaceContext = createContext<WidgetSurface>("chat");

export const WidgetSurfaceProvider = WidgetSurfaceContext.Provider;

export function useWidgetSurface(): WidgetSurface {
  return useContext(WidgetSurfaceContext);
}
