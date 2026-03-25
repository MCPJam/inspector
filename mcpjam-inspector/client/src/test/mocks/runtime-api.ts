import { vi } from "vitest";
import type { AppRuntimeContextValue } from "@/state/app-state-context";

export function createMockRuntimeApi(
  overrides: Partial<AppRuntimeContextValue> = {},
): AppRuntimeContextValue {
  return {
    connectRuntimeServer: vi.fn().mockResolvedValue(undefined),
    disconnectRuntimeServer: vi.fn().mockResolvedValue(undefined),
    getServerEntry: vi.fn(),
    ...overrides,
  };
}
