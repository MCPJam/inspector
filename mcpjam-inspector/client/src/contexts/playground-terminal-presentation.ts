import { createContext, useContext } from "react";
import { getHostStyleOrDefault } from "@/lib/client-styles";
import { useScenarioHostStyle } from "./scenario-client-style-context";

const PlaygroundTerminalPresentationContext = createContext(false);

export const PlaygroundTerminalPresentationProvider =
  PlaygroundTerminalPresentationContext.Provider;

export function usePlaygroundTerminalPresentation() {
  const enabled = useContext(PlaygroundTerminalPresentationContext);
  const hostStyle = useScenarioHostStyle();
  return enabled ? getHostStyleOrDefault(hostStyle).chatUi.terminal : undefined;
}
