import { vi } from "vitest";
import { clientRuntimeMocks } from "./client-runtime";

vi.mock("@/lib/mcp-ui/openai-widget-state-messages", () => ({
  buildWidgetStateParts: clientRuntimeMocks.buildWidgetStatePartsMock,
}));

export {
  applyClientRuntimePresets,
  clientRuntimeMocks,
} from "./client-runtime";
