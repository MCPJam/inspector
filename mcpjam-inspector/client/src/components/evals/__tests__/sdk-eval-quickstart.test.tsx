import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import {
  SdkEvalQuickstart,
  SDK_EVAL_QUICKSTART_INSTALL,
  SDK_EVAL_QUICKSTART_ENV,
  SDK_EVAL_QUICKSTART_RUN,
  buildShellEnvSnippet,
} from "../sdk-eval-quickstart";

const mockUseQuery = vi.fn();
const mockRegenerate = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => mockRegenerate,
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ signIn: vi.fn() }),
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("SdkEvalQuickstart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockImplementation((_name: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      return [];
    });
    mockRegenerate.mockResolvedValue({
      apiKey: "mcpjam_revealed_test_key",
      key: { _id: "k1", prefix: "ab", name: "default" },
    });
  });

  it("renders install, environment, and run sections", async () => {
    const { copyToClipboard } = await import("@/lib/clipboard");
    vi.mocked(copyToClipboard).mockResolvedValue(true);

    renderWithProviders(<SdkEvalQuickstart workspaceId="ws-1" />);

    expect(screen.getByRole("heading", { name: "Install" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Configure environment" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Run the quickstart" }),
    ).toBeTruthy();
    expect(screen.getByText(SDK_EVAL_QUICKSTART_INSTALL)).toBeTruthy();
    expect(SDK_EVAL_QUICKSTART_ENV).toMatch(/MCPJAM_API_KEY/);
    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/createEvalRunReporter/);
    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/greet/);
    expect(
      screen.getAllByText(/mcp-eval\.quickstart\.test\.ts/).length,
    ).toBeGreaterThanOrEqual(1);
    expect(document.body.textContent).toContain("workspace-api-key");
    expect(document.body.textContent).toContain("learn.mcpjam.com");
    expect(document.body.textContent).toContain("openai");
    expect(document.body.textContent).toContain("openrouter");
    expect(screen.getByRole("tab", { name: "Shell" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: ".env" })).toBeTruthy();
  });

  it("copies install snippet when copy is triggered", async () => {
    const user = userEvent.setup();
    const { copyToClipboard } = await import("@/lib/clipboard");
    vi.mocked(copyToClipboard).mockResolvedValue(true);

    renderWithProviders(<SdkEvalQuickstart />);

    const installCopy = screen.getByRole("button", {
      name: "Copy install command",
    });
    await user.click(installCopy);

    expect(copyToClipboard).toHaveBeenCalledWith(SDK_EVAL_QUICKSTART_INSTALL);
  });

  it("copies full run snippet when run section copy is triggered", async () => {
    const user = userEvent.setup();
    const { copyToClipboard } = await import("@/lib/clipboard");
    vi.mocked(copyToClipboard).mockResolvedValue(true);

    renderWithProviders(<SdkEvalQuickstart />);

    const runCopy = screen.getByRole("button", {
      name: "Copy quickstart test file",
    });
    await user.click(runCopy);

    expect(copyToClipboard).toHaveBeenCalledWith(SDK_EVAL_QUICKSTART_RUN);
    expect(copyToClipboard).toHaveBeenCalledTimes(1);
  });

  it("copies shell environment snippet from tabs", async () => {
    const user = userEvent.setup();
    const { copyToClipboard } = await import("@/lib/clipboard");
    vi.mocked(copyToClipboard).mockResolvedValue(true);

    renderWithProviders(<SdkEvalQuickstart workspaceId="ws-1" />);

    await user.click(
      screen.getByRole("button", { name: "Copy environment variables" }),
    );

    expect(copyToClipboard).toHaveBeenCalledWith(buildShellEnvSnippet(null));
  });

  it("embeds revealed API key in shell snippet after Generate API key", async () => {
    const user = userEvent.setup();
    mockUseQuery.mockImplementation((_name: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      return [];
    });
    mockRegenerate.mockResolvedValue({
      apiKey: "mcpjam_inline_secret_xyz",
      key: {
        _id: "k1",
        prefix: "xz",
        name: "default",
        createdAt: 1,
        lastUsedAt: null,
        revokedAt: null,
      },
    });

    renderWithProviders(<SdkEvalQuickstart workspaceId="ws-1" />);

    await user.click(screen.getByRole("button", { name: "Generate API key" }));

    expect(mockRegenerate).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    expect(
      await screen.findByDisplayValue("mcpjam_inline_secret_xyz"),
    ).toBeTruthy();

    expect(document.body.textContent).toContain("mcpjam_inline_secret_xyz");
    expect(document.body.textContent).toContain(
      'export MCPJAM_API_KEY="mcpjam_inline_secret_xyz"',
    );
  });
});
