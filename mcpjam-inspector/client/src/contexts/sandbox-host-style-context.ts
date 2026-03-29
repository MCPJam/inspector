import { createContext, useContext } from "react";
import type { SandboxHostStyle } from "@/lib/sandbox-host-style";

const SandboxHostStyleContext = createContext<SandboxHostStyle | null>(null);
const SandboxHostThemeContext = createContext<"light" | "dark" | null>(null);

export const SandboxHostStyleProvider = SandboxHostStyleContext.Provider;
export const SandboxHostThemeProvider = SandboxHostThemeContext.Provider;

export function useSandboxHostStyle(): SandboxHostStyle | null {
  return useContext(SandboxHostStyleContext);
}

export function useSandboxHostTheme(): "light" | "dark" | null {
  return useContext(SandboxHostThemeContext);
}
