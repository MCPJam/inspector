import type { UIMessage } from "ai";
import { vi } from "vitest";
import { mcpApiPresets } from "./mcp-api";
import { storePresets } from "./stores";

type WidgetStatePartsBuilder = (
  toolCallId: string,
  state: unknown,
) => Promise<UIMessage["parts"]>;

export const clientRuntimeMocks = {
  authFetchMock: vi.fn(),
  useAppStateMock: vi.fn(),
  mcpApiMock: {} as Record<string, unknown>,
  buildWidgetStatePartsMock: vi.fn<WidgetStatePartsBuilder>(),
  hostedMode: false,
};

interface ApplyClientRuntimePresetsOptions {
  mcpApi?: Record<string, unknown>;
  appState?: ReturnType<typeof storePresets.empty>;
  hostedMode?: boolean;
  buildWidgetStateParts?: WidgetStatePartsBuilder;
}

export function applyClientRuntimePresets(
  options: ApplyClientRuntimePresetsOptions = {},
): void {
  const {
    mcpApi = mcpApiPresets.allSuccess(),
    appState = storePresets.empty(),
    hostedMode = false,
    buildWidgetStateParts,
  } = options;

  Object.assign(clientRuntimeMocks.mcpApiMock, mcpApi);
  clientRuntimeMocks.useAppStateMock.mockReturnValue(appState);
  clientRuntimeMocks.hostedMode = hostedMode;
  clientRuntimeMocks.authFetchMock.mockReset();
  clientRuntimeMocks.buildWidgetStatePartsMock.mockReset();

  if (buildWidgetStateParts) {
    clientRuntimeMocks.buildWidgetStatePartsMock.mockImplementation(
      buildWidgetStateParts,
    );
  }
}
