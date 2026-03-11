import { createContext, useContext } from "react";
import type { SandboxHostStyle } from "@/lib/sandbox-host-style";

const SandboxHostStyleContext = createContext<SandboxHostStyle | null>(null);

export const SandboxHostStyleProvider = SandboxHostStyleContext.Provider;

export function useSandboxHostStyle(): SandboxHostStyle | null {
  return useContext(SandboxHostStyleContext);
}
