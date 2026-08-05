import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test";
import {
  SdkEvalQuickstart,
  SDK_EVAL_QUICKSTART_INSTALL,
  SDK_EVAL_QUICKSTART_ENV,
  SDK_EVAL_QUICKSTART_DOTENV,
  SDK_EVAL_QUICKSTART_RUN,
  buildSdkEvalQuickstartDotenv,
} from "../sdk-eval-quickstart";

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(() => Promise.resolve(true)),
}));

const mocks = vi.hoisted(() => ({
  workosUser: { current: { id: "user-1" } as { id: string } | null },
  signIn: vi.fn(),
  listApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  writeApiKeysSignInReturnPath: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: mocks.workosUser.current, signIn: mocks.signIn }),
}));

vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationQueries: () => ({
    sortedOrganizations: [{ _id: "org-1", name: "Acme" }],
    isLoading: false,
  }),
}));

vi.mock("@/lib/apis/web/api-keys", () => ({
  listApiKeys: (...args: unknown[]) => mocks.listApiKeys(...args),
  createApiKey: (...args: unknown[]) => mocks.createApiKey(...args),
  revokeApiKey: (...args: unknown[]) => mocks.revokeApiKey(...args),
}));

vi.mock("@/lib/api-keys-signin-return-path", () => ({
  writeApiKeysSignInReturnPath: (...args: unknown[]) =>
    mocks.writeApiKeysSignInReturnPath(...args),
}));

beforeEach(() => {
  mocks.workosUser.current = { id: "user-1" };
  mocks.listApiKeys.mockReset().mockResolvedValue([]);
  mocks.createApiKey.mockReset();
  mocks.signIn.mockReset();
  mocks.writeApiKeysSignInReturnPath.mockReset();
});

describe("SdkEvalQuickstart", () => {
  it("renders all four step cards with content visible", () => {
    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

    expect(
      screen.getByText("Create a project and install the SDK"),
    ).toBeTruthy();
    expect(screen.getByText("Set environment")).toBeTruthy();
    expect(
      screen.getByText("Add mcp-eval.quickstart.test.ts to your project"),
    ).toBeTruthy();
    expect(screen.getByText("Run the demo test")).toBeTruthy();

    // All content visible without expansion
    expect(document.body.textContent).toContain("npm install @mcpjam/sdk");
    expect(document.body.textContent).toContain("learn.mcpjam.com");
    expect(document.body.textContent).toContain("openai");
    expect(
      screen.getAllByText(/mcp-eval\.quickstart\.test\.ts/).length,
    ).toBeGreaterThanOrEqual(1);

    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/EvalTest/);
    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/evalTest\.run/);
    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/evalTest\.accuracy/);
  });

  it("wires sk_-keyed reporting and never the retired mcpjam_ keys", () => {
    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

    // Reporting runs on MCPJam API keys (sk_) — same env var, new key kind.
    expect(SDK_EVAL_QUICKSTART_ENV).toMatch(/MCPJAM_API_KEY=<your sk_/);
    expect(SDK_EVAL_QUICKSTART_DOTENV).toMatch(/MCPJAM_API_KEY=<your sk_/);
    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/mcpjam:/);
    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/suiteName/);

    // The quickstart targets the current project via MCPJAM_PROJECT_ID.
    expect(buildSdkEvalQuickstartDotenv("ws-1")).toContain(
      "MCPJAM_PROJECT_ID=ws-1",
    );
    expect(buildSdkEvalQuickstartDotenv(null)).not.toContain(
      "MCPJAM_PROJECT_ID",
    );
    expect(document.body.textContent).toContain("MCPJAM_PROJECT_ID=ws-1");

    // The retired key kind must never resurface.
    expect(document.body.textContent).not.toContain("mcpjam_");
    // INVERTED (SDK-runs MVP): the quickstart now mints keys in-app. It used
    // to assert the opposite — sending readers to Settings → API keys was
    // where activation died. Asserted by ROLE+NAME so a renamed button fails
    // this test rather than silently passing a stale absence check.
    expect(screen.getByRole("button", { name: "Create API key" })).toBeTruthy();
  });

  it("mints a key inline and injects it into the .env snippet", async () => {
    const user = userEvent.setup();
    mocks.createApiKey.mockResolvedValue({
      id: "key-1",
      name: "ci",
      obfuscated_value: "sk_...abcd",
      value: "sk_live_supersecret",
    });

    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

    await user.click(screen.getByRole("button", { name: "Create API key" }));
    await user.type(screen.getByLabelText("Name"), "ci");
    await user.click(screen.getByRole("button", { name: "Create key" }));

    await waitFor(() => {
      expect(mocks.createApiKey).toHaveBeenCalledWith({
        name: "ci",
        // Single org auto-selects, so the reader never picks one.
        organizationId: "org-1",
      });
    });

    // The point of minting here: the snippet the reader copies next already
    // works, with no trip to Settings to hand-carry the value back.
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "MCPJAM_API_KEY=sk_live_supersecret",
      );
    });
    expect(document.body.textContent).toContain("shown once");
    expect(screen.getByText("Key created")).toBeTruthy();
  });

  it("renders a mint failure inline instead of toasting it", async () => {
    const user = userEvent.setup();
    mocks.createApiKey.mockRejectedValue(
      new Error(
        "This organization is still being set up for API keys — please try again shortly.",
      ),
    );

    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

    await user.click(screen.getByRole("button", { name: "Create API key" }));
    await user.type(screen.getByLabelText("Name"), "ci");
    await user.click(screen.getByRole("button", { name: "Create key" }));

    // The WorkOS-org-sync 409 is the one failure a first-time user actually
    // hits, and its copy already tells them to retry.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("try again shortly");
    expect(document.body.textContent).not.toContain("MCPJAM_API_KEY=sk_");
  });

  it("shows an existing key as already created without minting", async () => {
    mocks.listApiKeys.mockResolvedValue([
      { id: "key-1", name: "ci", obfuscated_value: "sk_...abcd" },
    ]);

    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

    expect(await screen.findByText("Key created")).toBeTruthy();
    // …but no plaintext value: WorkOS reveals it once, at mint time only.
    expect(document.body.textContent).toContain("<your sk_…");
  });

  it("offers sign-in instead of minting for guests, and never calls the key API", async () => {
    const user = userEvent.setup();
    mocks.workosUser.current = null;

    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

    expect(screen.queryByRole("button", { name: "Create API key" })).toBeNull();
    // /ci-evals is guest-reachable (EvalTabGate only gates the playground
    // variant) and /api/web/api-keys requires a session bearer — firing the
    // list here would be a guaranteed 401 with an error to show for it.
    expect(mocks.listApiKeys).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Sign in to create an API key" }),
    );
    expect(mocks.writeApiKeysSignInReturnPath).toHaveBeenCalledWith(
      "/ci-evals",
    );
    expect(mocks.signIn).toHaveBeenCalled();
  });

  it("says the page updates itself while waiting for the first run", () => {
    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

    expect(document.body.textContent).toContain("Waiting for your first run");
    expect(document.body.textContent).toContain("updates automatically");
  });

  it("shows the SDK docs link", () => {
    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

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
  });

  it("copies dotenv snippet when copy is triggered", async () => {
    const user = userEvent.setup();
    const { copyToClipboard } = await import("@/lib/clipboard");
    vi.mocked(copyToClipboard).mockResolvedValue(true);

    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

    await user.click(screen.getByRole("button", { name: "Copy .env" }));

    expect(copyToClipboard).toHaveBeenCalledWith(
      buildSdkEvalQuickstartDotenv("ws-1"),
    );
  });
});
