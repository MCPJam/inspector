import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RecommendedHosts } from "../RecommendedHosts";

const state = vi.hoisted(() => ({
  claude: false,
  codex: false,
  create: vi.fn(),
}));
vi.mock("@/hooks/useClaudeCodeHostEnabled", () => ({
  useClaudeCodeHostEnabled: () => state.claude,
}));
vi.mock("@/hooks/useCodexHostEnabled", () => ({
  useCodexHostEnabled: () => state.codex,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useHostMutations: () => ({ createHost: state.create }),
}));
vi.mock("@/hooks/useProjects", () => ({
  PROJECT_CLIENTS_ADMIN_ONLY_MESSAGE: "Admin required",
  useCanManageProjectClients: () => ({ canManage: true }),
}));
vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => vi.fn(),
  buildHostsPath: (id: string) => `/hosts/${id}`,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/host-ui-metadata", () => ({
  getHostLogoSrc: () => "/logo.svg",
}));
vi.mock("@/lib/host-compat/use-host-catalog", () => ({
  useHostCatalog: () => ({ status: "live", catalog: {} }),
}));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (s: { themeMode: string }) => unknown) =>
    selector({ themeMode: "light" }),
}));
vi.mock("@mcpjam/sdk/host-compat", () => ({
  getCatalogHost: (_catalog: unknown, id: string) => ({ id, label: id }),
  getCatalogTemplate: (_catalog: unknown, id: string) => ({ id }),
}));
vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: ({ initialTemplateId }: { initialTemplateId: string }) =>
    <div role="dialog">Setup {initialTemplateId}</div>,
}));

describe("recommended harness clients", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.claude = false;
    state.codex = false;
    state.create.mockResolvedValue({ hostId: "created" });
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("honors each rollout gate (%s, %s)", (claude, codex) => {
    state.claude = claude;
    state.codex = codex;
    render(<RecommendedHosts projectId="project" />);
    expect(
      Boolean(screen.queryByRole("button", { name: "claude-codeCreate" })),
    ).toBe(claude);
    expect(
      Boolean(screen.queryByRole("button", { name: "codexCreate" })),
    ).toBe(codex);
    expect(screen.getByRole("button", { name: "claudeCreate" })).toBeEnabled();
  });

  it("opens the selected harness in the existing setup dialog before creating", () => {
    state.codex = true;
    render(<RecommendedHosts projectId="project" />);
    fireEvent.click(screen.getByRole("button", { name: "codexCreate" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Setup codex");
    expect(state.create).not.toHaveBeenCalled();
  });
});
