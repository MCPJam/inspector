import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import {
  SdkEvalQuickstart,
  SDK_EVAL_QUICKSTART_INSTALL,
  SDK_EVAL_QUICKSTART_ENV,
  SDK_EVAL_QUICKSTART_RUN,
  buildShellEnvSnippet,
  buildDotEnvSnippet,
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

  it("renders all four step cards with content visible", () => {
    renderWithProviders(<SdkEvalQuickstart workspaceId="ws-1" />);

    expect(screen.getByText("Create a project and install the SDK")).toBeTruthy();
    expect(screen.getByText("Set environment")).toBeTruthy();
    expect(
      screen.getByText("Add mcp-eval.quickstart.test.ts to your project"),
    ).toBeTruthy();
    expect(screen.getByText("Run the demo test")).toBeTruthy();

    // All content visible without expansion
    expect(document.body.textContent).toContain("npm install @mcpjam/sdk");
    expect(document.body.textContent).toContain("workspace-api-key");
    expect(document.body.textContent).toContain("learn.mcpjam.com");
    expect(document.body.textContent).toContain("openai");
    expect(
      screen.getAllByText(/mcp-eval\.quickstart\.test\.ts/).length,
    ).toBeGreaterThanOrEqual(1);

    expect(SDK_EVAL_QUICKSTART_ENV).toMatch(/MCPJAM_API_KEY/);
    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/createEvalRunReporter/);
    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/greet/);
  });

  it("shows the SDK docs link", () => {
    renderWithProviders(<SdkEvalQuickstart workspaceId="ws-1" />);

    const docsLink = screen.getByRole("link", {
      name: "Learn more and see all providers in the SDK docs",
    });

    expect(docsLink).toHaveAttribute("href", "https://docs.mcpjam.com/sdk");
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

  it("copies shell exports snippet when copy is triggered", async () => {
    const user = userEvent.setup();
    const { copyToClipboard } = await import("@/lib/clipboard");
    vi.mocked(copyToClipboard).mockResolvedValue(true);

    renderWithProviders(<SdkEvalQuickstart workspaceId="ws-1" />);

    await user.click(screen.getByRole("button", { name: "Copy exports" }));

    expect(copyToClipboard).toHaveBeenCalledWith(buildShellEnvSnippet(null));
  });

  it("embeds revealed API key in .env snippet after Generate API key", async () => {
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
  });

  it("buildShellEnvSnippet and buildDotEnvSnippet produce valid output", () => {
    const shell = buildShellEnvSnippet("test_key");
    expect(shell).toContain('export MCPJAM_API_KEY="test_key"');
    expect(shell).toContain("EVAL_MODEL");

    const dotenv = buildDotEnvSnippet("test_key");
    expect(dotenv).toContain('MCPJAM_API_KEY="test_key"');
    expect(dotenv).toContain("EVAL_MODEL");

    const shellNoKey = buildShellEnvSnippet(null);
    expect(shellNoKey).toContain("workspace-api-key");

    const dotenvNoKey = buildDotEnvSnippet(null);
    expect(dotenvNoKey).toContain("workspace-api-key");
  });
});
