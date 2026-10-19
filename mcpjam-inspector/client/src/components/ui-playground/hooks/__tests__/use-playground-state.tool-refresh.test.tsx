import { beforeEach, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { createServer } from "@/test/factories";
import { executeToolApi, listTools } from "@/lib/apis/mcp-tools-api";
import { usePlaygroundState } from "../use-playground-state";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(), useQuery: () => undefined,
  useAction: () => vi.fn(), useConvex: () => ({}),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: false }),
}));
vi.mock("@/lib/apis/mcp-tools-api", async (original) => ({
  ...await original<typeof import("@/lib/apis/mcp-tools-api")>(),
  listTools: vi.fn(), executeToolApi: vi.fn(),
}));
function wrapper({ children }: { children: React.ReactNode }) {
  return <PreferencesStoreProvider themeMode="light" themePreset="default">
    <SidebarProvider>{children}</SidebarProvider>
  </PreferencesStoreProvider>;
}
beforeEach(() => {
  useUIPlaygroundStore.getState().reset();
  vi.mocked(listTools).mockResolvedValue({ tools: [{
    name: "write", inputSchema: { type: "object", properties: { value: { type: "string" } } },
  }] });
});
it.each([false, true])("keeps inputs and completion after list refresh (error=%s)", async (failed) => {
  const server = createServer({ name: "bench", connectionStatus: "connected" });
  const { result } = renderHook(() => usePlaygroundState({
    serverName: "bench", serverConfig: server.config, servers: { bench: server },
  }), { wrapper });
  await waitFor(() => expect(useUIPlaygroundStore.getState().tools.write).toBeDefined());
  act(() => useUIPlaygroundStore.getState().setSelectedTool("write"));
  act(() => {
    const state = useUIPlaygroundStore.getState();
    state.updateFormField("value", "kept");
    state.updateFormFieldIsSet("value", true);
    if (failed) state.setExecutionError("Retry refused");
    else state.setToolOutput({ value: "kept" });
  });
  await act(async () => { await result.current.fetchTools(); });
  const state = useUIPlaygroundStore.getState();
  expect(state.selectedTool).toBe("write");
  expect(state.formFields[0].value).toBe("kept");
  expect(failed ? state.executionError : state.toolOutput).toEqual(failed ? "Retry refused" : { value: "kept" });
});

const replay = vi.hoisted(() => ({ current: false }));
const descriptor = { kind: "tool", surface: "playground", serverName: "bench", toolName: "write", parameters: { value: "saved" } };
vi.mock("@/lib/scope-step-up-replay", () => ({
  peekPendingDirectScopeStepUpReplay: () => replay.current ? { descriptor } : null,
  claimPendingDirectScopeStepUpReplay: () => {
    if (!replay.current) return null;
    replay.current = false;
    return { descriptor };
  },
  clearPendingDirectScopeStepUpReplay: vi.fn(),
}));
vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: () => ({ servers: { bench: createServer({ name: "bench", connectionStatus: "connected" }) } }),
}));
it("keeps restored selection when the server hydrates after tools", async () => {
  const server = createServer({ name: "bench", connectionStatus: "connected" });
  const tools = { write: { name: "write", inputSchema: { type: "object" as const, properties: { value: { type: "string" } } } } };
  vi.mocked(executeToolApi).mockResolvedValue({ status: "completed", result: { content: [{ type: "text", text: "saved" }] } });
  const { rerender } = renderHook(({ name }: { name: string | undefined }) => usePlaygroundState({
    serverName: name, serverConfig: name ? server.config : undefined, servers: { bench: server },
  }), { wrapper, initialProps: { name: undefined as string | undefined } });
  act(() => useUIPlaygroundStore.getState().setTools(tools));
  replay.current = true;
  rerender({ name: "bench" });
  await waitFor(() => expect(executeToolApi).toHaveBeenCalled());
  expect(useUIPlaygroundStore.getState().selectedTool).toBe("write");
  expect(useUIPlaygroundStore.getState().formFields[0].value).toBe("saved");
});
