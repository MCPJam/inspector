import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test";
import type { Project } from "@/state/app-types";
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
  authLoading: { current: false },
  // Keyed by project id, the shape `findProjectByAnyId` walks. The org here is
  // what narrows the mint dialog's organization list.
  //
  // Typed against the real `Project` rather than `unknown`: a rename of
  // `organizationId` must fail the typecheck here, not silently leave the org
  // list unnarrowed at runtime with this test still green.
  projects: {
    current: { "ws-1": { organizationId: "org-1" } } as Record<
      string,
      Pick<Project, "organizationId">
    >,
  },
  organizations: {
    current: [{ _id: "org-1", name: "Acme" }] as Array<{
      _id: string;
      name: string;
    }>,
  },
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
  useAuth: () => ({
    user: mocks.workosUser.current,
    signIn: mocks.signIn,
    isLoading: mocks.authLoading.current,
  }),
}));

vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationQueries: () => ({
    sortedOrganizations: mocks.organizations.current,
    isLoading: false,
  }),
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({ projects: mocks.projects.current }),
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
  mocks.authLoading.current = false;
  mocks.projects.current = { "ws-1": { organizationId: "org-1" } };
  mocks.organizations.current = [{ _id: "org-1", name: "Acme" }];
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
      value: "mcpjam-test-plaintext-key",
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
        "MCPJAM_API_KEY=mcpjam-test-plaintext-key",
      );
    });
    const secretBlock = document.querySelector("[data-ph-no-capture]");
    expect(secretBlock).toHaveClass("ph-no-capture", "rr-block");
    expect(document.body.textContent).toContain("shown once");
    expect(screen.getByText("API key available")).toBeTruthy();
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

    expect(await screen.findByText("API key available")).toBeTruthy();
    // …but no plaintext value: WorkOS reveals it once, at mint time only.
    expect(document.body.textContent).toContain("<your sk_…");
  });

  it("offers sign-in instead of minting for guests, and never calls the key API", async () => {
    const user = userEvent.setup();
    mocks.workosUser.current = null;

    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

    expect(screen.queryByRole("button", { name: "Create API key" })).toBeNull();
    // /evals/runs is guest-reachable (EvalTabGate only gates the playground
    // variant) and /api/web/api-keys requires a session bearer — firing the
    // list here would be a guaranteed 401 with an error to show for it.
    expect(mocks.listApiKeys).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Sign in to create an API key" }),
    );
    expect(mocks.writeApiKeysSignInReturnPath).toHaveBeenCalledWith(
      "/evals/runs",
    );
    expect(mocks.signIn).toHaveBeenCalled();
  });

  it("offers only the project's own organization to a multi-org user", async () => {
    const user = userEvent.setup();
    // The key must live in the org that owns this project or ingestion
    // rejects it. Offering the full list lets a reader copy a key/project
    // pair that cannot work, and only find out from a failing CI run.
    mocks.organizations.current = [
      { _id: "org-1", name: "Acme" },
      { _id: "org-2", name: "Unrelated" },
    ];

    // Resolved, so the mint actually COMPLETES. Without an implementation the
    // mock returns undefined, `created.value` throws, the dialog swallows it,
    // and the `toHaveBeenCalledWith` below still passes — a green test over a
    // masked TypeError that never exercised the narrowed-org mint at all.
    mocks.createApiKey.mockResolvedValue({
      id: "key-1",
      name: "ci",
      obfuscated_value: "sk_...abcd",
      value: "mcpjam-test-plaintext-key",
    });

    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);
    await user.click(screen.getByRole("button", { name: "Create API key" }));

    // Narrowed to one ⇒ the dialog auto-selects and disables the picker, so
    // the unrelated org is not offered at all.
    expect(screen.queryByText("Unrelated")).toBeNull();
    await user.type(screen.getByLabelText("Name"), "ci");
    await user.click(screen.getByRole("button", { name: "Create key" }));
    await waitFor(() =>
      expect(mocks.createApiKey).toHaveBeenCalledWith({
        name: "ci",
        organizationId: "org-1",
      }),
    );
    // The mint ran to completion, which is what proves the narrowed org was
    // usable rather than merely selected.
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "MCPJAM_API_KEY=mcpjam-test-plaintext-key",
      ),
    );
  });

  it("blocks minting while the project's organization is unresolved", () => {
    // Reachable two ways: app state not yet hydrated, and
    // `Project.organizationId` being optional. Falling back to the full org
    // list here would let a multi-org reader mint into an org that doesn't own
    // the MCPJAM_PROJECT_ID in the snippet — the exact mismatch the narrowing
    // exists to prevent — so the mint is held instead.
    mocks.projects.current = {};
    mocks.organizations.current = [
      { _id: "org-1", name: "Acme" },
      { _id: "org-2", name: "Unrelated" },
    ];

    renderWithProviders(<SdkEvalQuickstart projectId="ws-unknown" />);

    expect(
      screen.getByRole("button", { name: "Create API key" }),
    ).toBeDisabled();
    expect(document.body.textContent).toContain(
      "Resolving this project's organization",
    );
  });

  it("offers every org when there is no project at all", async () => {
    const user = userEvent.setup();
    // No project ⇒ nothing for a key to mismatch, so the unfiltered list is
    // correct here rather than a hole.
    mocks.projects.current = {};
    mocks.organizations.current = [
      { _id: "org-1", name: "Acme" },
      { _id: "org-2", name: "Unrelated" },
    ];

    renderWithProviders(<SdkEvalQuickstart projectId={null} />);

    const mintButton = screen.getByRole("button", { name: "Create API key" });
    expect(mintButton).not.toBeDisabled();
    await user.click(mintButton);
    // Two orgs ⇒ a real picker instead of an auto-selection.
    expect(screen.getByLabelText("Organization")).toBeTruthy();
  });

  it("drops the minted key when the project changes", async () => {
    const user = userEvent.setup();
    mocks.createApiKey.mockResolvedValue({
      id: "key-1",
      name: "ci",
      obfuscated_value: "sk_...abcd",
      value: "mcpjam-test-plaintext-key",
    });

    const { rerender } = renderWithProviders(
      <SdkEvalQuickstart projectId="ws-1" />,
    );
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    await user.type(screen.getByLabelText("Name"), "ci");
    await user.click(screen.getByRole("button", { name: "Create key" }));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "MCPJAM_API_KEY=mcpjam-test-plaintext-key",
      ),
    );

    // Switching projects must not leave the old project's key paired with the
    // new project's MCPJAM_PROJECT_ID — that combination ingestion rejects.
    mocks.projects.current = { "ws-2": { organizationId: "org-1" } };
    rerender(<SdkEvalQuickstart projectId="ws-2" />);

    expect(document.body.textContent).not.toContain(
      "MCPJAM_API_KEY=mcpjam-test-plaintext-key",
    );
    expect(document.body.textContent).toContain("MCPJAM_PROJECT_ID=ws-2");
  });

  it("shows neither the mint button nor the guest CTA until auth resolves", () => {
    // `user` is absent while WorkOS loads, so a signed-in reader would
    // otherwise see — and could click — the guest sign-in CTA.
    mocks.authLoading.current = true;
    mocks.workosUser.current = null;

    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

    expect(screen.queryByRole("button", { name: "Create API key" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Sign in to create an API key" }),
    ).toBeNull();
    expect(document.body.textContent).toContain("Checking your session");
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
