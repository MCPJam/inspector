import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════════
// GITHUB'S RETURN PATH, BOTH LEGS
// ═══════════════════════════════════════════════════════════════════════════
//
// The App's setup URL and its OAuth callback point at the SAME path, and the
// page tells them apart by which query parameters arrived. What these pin:
//
//   1. Parameters are forwarded VERBATIM. The backend matches states by hash
//      and treats the installation id as a claim GitHub itself says can be
//      spoofed, so any normalization here could only turn a legitimate state
//      into a non-matching one.
//   2. The setup leg follows the server-built authorize URL and nothing else.
//   3. A direct-install claim comes back as a PICK, and the pick sends the
//      session id the server issued — which is not authority on its own; the
//      backend re-checks the actor, the session, and the proven list.
//   4. Every failure renders the copy the backend worded, and a URL with
//      neither leg's parameters says so plainly instead of looking broken.

const {
  mockCompleteInstallSetup,
  mockCompleteUserAuthorization,
  mockClaimProvenInstallation,
  mockRedirectToGithub,
  mockNavigate,
  mockAuth,
  mockUserReady,
  mockWorkosAuth,
} = vi.hoisted(() => ({
  mockCompleteInstallSetup: vi.fn(),
  mockCompleteUserAuthorization: vi.fn(),
  mockClaimProvenInstallation: vi.fn(),
  mockRedirectToGithub: vi.fn(),
  mockNavigate: vi.fn(),
  // Both legs are `signedInAction`s reached by a FULL PAGE LOAD from GitHub,
  // so auth state is a real input to this page and not scaffolding: the
  // default here is the settled, signed-in case, and the tests that matter
  // move it.
  mockAuth: vi.fn(() => ({ isLoading: false, isAuthenticated: true })),
  mockUserReady: vi.fn(() => true),
  // The WORKOS user, which is the one that decides. Convex reports guests as
  // authenticated on purpose (`unified-convex-auth` gives them a token and a
  // placeholder user), so this mock is not a duplicate of `mockAuth` — it is
  // the only thing that tells a member from a guest.
  mockWorkosAuth: vi.fn(() => ({
    user: { id: "user_workos" } as unknown,
    isLoading: false,
  })),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockAuth(),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => mockWorkosAuth(),
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => mockUserReady(),
}));

vi.mock("@/hooks/useGithubChecksSettings", () => ({
  useGithubInstallCallbacks: () => ({
    completeInstallSetup: mockCompleteInstallSetup,
    completeUserAuthorization: mockCompleteUserAuthorization,
    claimProvenInstallation: mockClaimProvenInstallation,
  }),
}));

vi.mock("@/lib/github-external-redirect", () => ({
  redirectToGithub: mockRedirectToGithub,
}));

vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => mockNavigate,
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("../SettingsNav", () => ({
  SettingsNav: () => <nav data-testid="settings-nav" />,
}));

import { toast } from "@/lib/toast";
import { GithubInstallCallbackRoute } from "../GithubInstallCallbackRoute";

const PATH = "/settings/integrations/github/callback";

/**
 * Rendered inside `StrictMode` deliberately.
 *
 * StrictMode mounts, unmounts and remounts in development, running the effect
 * twice — and BOTH legs consume a single-use state, so a second run would burn
 * it and land the user on a refusal having done nothing wrong. A `rerender`
 * would not exercise that: it keeps the same instance, so the guard's ref
 * survives for a reason unrelated to the double mount.
 */
function renderCallback(query: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[`${PATH}${query}`]}>
        <Routes>
          <Route path={PATH} element={<GithubInstallCallbackRoute />} />
        </Routes>
      </MemoryRouter>
    </StrictMode>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockReturnValue({ isLoading: false, isAuthenticated: true });
  mockUserReady.mockReturnValue(true);
  mockWorkosAuth.mockReturnValue({
    user: { id: "user_workos" },
    isLoading: false,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTH MUST LAND BEFORE EITHER LEG IS CALLED
// ═══════════════════════════════════════════════════════════════════════════
//
// This page is reached by a full page load from GitHub's redirect, so the
// Convex client has NOT attached a token when the effect first runs. Calling a
// `signedInAction` in that window throws `Authentication required` — a plain
// `Error`, which the production mask turns into a bare `Server Error` — and
// leaves the one-time state unconsumed with the flow dead.
//
// This shipped and broke every bind in production. A `useQuery` would have
// survived it by re-running once auth arrived; a one-shot effect does not,
// which is precisely why the gate has to be explicit here.
describe("waiting for authentication", () => {
  it("calls neither leg while auth is still resolving", async () => {
    mockAuth.mockReturnValue({ isLoading: true, isAuthenticated: false });
    renderCallback("?code=gh-code&state=raw-oauth-state");

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(mockCompleteUserAuthorization).not.toHaveBeenCalled();
    expect(mockCompleteInstallSetup).not.toHaveBeenCalled();
    // Still "working" — an unresolved session is not a refusal.
    expect(screen.getByRole("status").textContent).toContain("Finishing up");
  });

  it("calls neither leg while the Convex user row is still being provisioned", async () => {
    // Authenticated with WorkOS is not the same as resolvable to a Convex user,
    // and the actions resolve the second.
    mockUserReady.mockReturnValue(false);
    renderCallback("?code=gh-code&state=raw-oauth-state");

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(mockCompleteUserAuthorization).not.toHaveBeenCalled();
  });

  it("runs the leg once auth arrives, without a remount", async () => {
    mockAuth.mockReturnValue({ isLoading: true, isAuthenticated: false });
    mockWorkosAuth.mockReturnValue({ user: null, isLoading: true });
    mockCompleteUserAuthorization.mockResolvedValue({
      status: "bound",
      accountLogin: "acme",
    });
    const { rerender } = renderCallback("?code=gh-code&state=raw-oauth-state");
    expect(mockCompleteUserAuthorization).not.toHaveBeenCalled();

    // The token lands. The guard must not have burned itself while waiting.
    mockAuth.mockReturnValue({ isLoading: false, isAuthenticated: true });
    mockWorkosAuth.mockReturnValue({
      user: { id: "user_workos" },
      isLoading: false,
    });
    rerender(
      <StrictMode>
        <MemoryRouter
          initialEntries={[`${PATH}?code=gh-code&state=raw-oauth-state`]}
        >
          <Routes>
            <Route path={PATH} element={<GithubInstallCallbackRoute />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>
    );

    await waitFor(() =>
      expect(mockCompleteUserAuthorization).toHaveBeenCalledTimes(1)
    );
    expect(mockCompleteUserAuthorization).toHaveBeenCalledWith({
      code: "gh-code",
      state: "raw-oauth-state",
    });
  });

  it("calls neither leg while the WorkOS session is still resolving", async () => {
    // Convex can already say "authenticated" here — a guest token satisfies it.
    mockWorkosAuth.mockReturnValue({ user: null, isLoading: true });
    renderCallback("?code=gh-code&state=raw-oauth-state");

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(mockCompleteUserAuthorization).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Finishing up");
  });

  it("refuses a GUEST with the sign-in message, and calls no action", async () => {
    // THE CASE `useConvexAuth` ALONE CANNOT SEE. `unified-convex-auth` gives a
    // guest a real Convex token and a placeholder user, so `isAuthenticated` is
    // true and `useEnsureDbUser` marks them ready — a gate built on those two
    // would send a guest into a member-only `signedInAction` and surface the
    // generic binding failure, and the sign-in branch would never fire.
    mockAuth.mockReturnValue({ isLoading: false, isAuthenticated: true });
    mockUserReady.mockReturnValue(true);
    mockWorkosAuth.mockReturnValue({ user: null, isLoading: false });
    renderCallback("?code=gh-code&state=raw-oauth-state");

    await waitFor(() =>
      expect(screen.getByText(/not signed in to MCPJam/i)).toBeTruthy()
    );
    expect(mockCompleteUserAuthorization).not.toHaveBeenCalled();
    expect(mockCompleteInstallSetup).not.toHaveBeenCalled();
  });

  it("says so plainly when auth resolves to signed out", async () => {
    mockAuth.mockReturnValue({ isLoading: false, isAuthenticated: false });
    mockWorkosAuth.mockReturnValue({ user: null, isLoading: false });
    renderCallback("?code=gh-code&state=raw-oauth-state");

    await waitFor(() =>
      expect(screen.getByText(/not signed in to MCPJam/i)).toBeTruthy()
    );
    expect(mockCompleteUserAuthorization).not.toHaveBeenCalled();
  });
});

describe("the setup leg", () => {
  it("forwards installation_id and state verbatim, then follows the authorize URL", async () => {
    mockCompleteInstallSetup.mockResolvedValue({
      authorizeUrl: "https://github.com/login/oauth/authorize?client_id=x",
    });
    renderCallback("?installation_id=4242&state=raw-install-state");

    await waitFor(() =>
      expect(mockCompleteInstallSetup).toHaveBeenCalledTimes(1)
    );
    // The state is passed EXACTLY as GitHub sent it. The backend matches by
    // hash, so trimming or lower-casing here would simply stop it matching.
    expect(mockCompleteInstallSetup).toHaveBeenCalledWith({
      installationId: 4242,
      state: "raw-install-state",
    });
    await waitFor(() =>
      expect(mockRedirectToGithub).toHaveBeenCalledWith(
        "https://github.com/login/oauth/authorize?client_id=x"
      )
    );
  });

  it("shows the backend's refusal rather than redirecting", async () => {
    mockCompleteInstallSetup.mockRejectedValue(
      Object.assign(new Error("Server Error"), {
        data: "We could not verify that installation with GitHub. This is not a problem with your repositories — start the connection again from Settings.",
      })
    );
    renderCallback("?installation_id=4242&state=s");

    expect(
      await screen.findByText(/could not verify that installation/i)
    ).toBeInTheDocument();
    expect(mockRedirectToGithub).not.toHaveBeenCalled();
  });

  it("refuses an installation_id that is not a positive integer", async () => {
    renderCallback("?installation_id=not-a-number&state=s");
    expect(
      await screen.findByText(/could not finish connecting/i)
    ).toBeInTheDocument();
    // Nothing was sent: there was nothing to send.
    expect(mockCompleteInstallSetup).not.toHaveBeenCalled();
  });

  it("runs the one-time state exchange exactly once under StrictMode", async () => {
    // The real hazard, and the reason `renderCallback` wraps in StrictMode:
    // the development double-mount would otherwise burn the single-use state
    // on its second run.
    mockCompleteInstallSetup.mockResolvedValue({
      authorizeUrl: "https://github.com/login/oauth/authorize",
    });
    renderCallback("?installation_id=1&state=s");

    await waitFor(() =>
      expect(mockCompleteInstallSetup).toHaveBeenCalledTimes(1)
    );
    // Let anything the second mount queued settle before asserting, so this
    // cannot pass merely by looking too early.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockCompleteInstallSetup).toHaveBeenCalledTimes(1);
  });

  it("shows the refusal when the returned URL is not a GitHub URL", async () => {
    // `redirectToGithub` throws on anything outside github.com, and that throw
    // lands in the same `.catch` as a backend refusal. The seam between the
    // redirect guard and this page is exactly where a regression would hide.
    mockCompleteInstallSetup.mockResolvedValue({
      authorizeUrl: "https://github.com.evil.test/login/oauth/authorize",
    });
    mockRedirectToGithub.mockImplementation(() => {
      throw new Error("Refused to redirect outside GitHub");
    });
    renderCallback("?installation_id=4242&state=s");

    expect(
      await screen.findByText(/could not finish connecting/i)
    ).toBeInTheDocument();
  });
});

describe("the OAuth leg", () => {
  it("forwards code and state verbatim and returns to settings when bound", async () => {
    mockCompleteUserAuthorization.mockResolvedValue({
      status: "bound",
      accountLogin: "acme",
    });
    renderCallback("?code=raw-code&state=raw-oauth-state");

    await waitFor(() =>
      expect(mockCompleteUserAuthorization).toHaveBeenCalledWith({
        code: "raw-code",
        state: "raw-oauth-state",
      })
    );
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith("/settings/integrations/github")
    );
    expect(toast.success).toHaveBeenCalledWith("Connected acme.");
  });

  it("renders the proven list for a direct-install claim", async () => {
    mockCompleteUserAuthorization.mockResolvedValue({
      status: "pick_required",
      linkSessionId: "sess-1",
      installations: [
        {
          installationId: 11,
          accountLogin: "acme",
          accountType: "Organization",
        },
        { installationId: 12, accountLogin: "dana", accountType: "User" },
      ],
    });
    renderCallback("?code=c&state=s");

    expect(await screen.findByText("acme")).toBeInTheDocument();
    expect(screen.getByText("dana")).toBeInTheDocument();
    expect(screen.getByText("Organization")).toBeInTheDocument();
    expect(screen.getByText("Personal account")).toBeInTheDocument();
  });

  it("offers ONLY what the backend proved", async () => {
    // The list is held server-side and re-read at the pick, so an installation
    // that is not in it cannot be selected — and must not be offered either.
    mockCompleteUserAuthorization.mockResolvedValue({
      status: "pick_required",
      linkSessionId: "sess-1",
      installations: [
        {
          installationId: 11,
          accountLogin: "acme",
          accountType: "Organization",
        },
      ],
    });
    renderCallback("?code=c&state=s");

    await screen.findByText("acme");
    expect(screen.queryByText("globex")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(1);
  });

  it("claims with the session id the server issued", async () => {
    mockCompleteUserAuthorization.mockResolvedValue({
      status: "pick_required",
      linkSessionId: "sess-1",
      installations: [
        {
          installationId: 11,
          accountLogin: "acme",
          accountType: "Organization",
        },
      ],
    });
    mockClaimProvenInstallation.mockResolvedValue({
      status: "bound",
      accountLogin: "acme",
    });
    const user = userEvent.setup();
    renderCallback("?code=c&state=s");
    await screen.findByText("acme");

    await user.click(screen.getByRole("button", { name: "Connect" }));

    // Possessing the session id is not authority — the backend re-checks that
    // the actor started the flow and that this installation is in the proven
    // list — so passing it through is safe and is the whole handshake.
    await waitFor(() =>
      expect(mockClaimProvenInstallation).toHaveBeenCalledWith({
        linkSessionId: "sess-1",
        installationId: 11,
      })
    );
  });

  it("says so plainly when the user has the app installed nowhere", async () => {
    // An EMPTY proven list is a real answer, not a failure.
    mockCompleteUserAuthorization.mockResolvedValue({
      status: "pick_required",
      linkSessionId: "sess-1",
      installations: [],
    });
    renderCallback("?code=c&state=s");

    expect(
      await screen.findByText(/not installed on any account you administer/i)
    ).toBeInTheDocument();
  });

  it("shows a non-disclosing conflict exactly as the backend worded it", async () => {
    mockCompleteUserAuthorization.mockRejectedValue(
      Object.assign(new Error("Server Error"), {
        data: "That GitHub installation is already connected to a workspace. This is not a problem with your repositories — ask whoever set it up to disconnect it first, or install the app on a different account.",
      })
    );
    renderCallback("?code=c&state=s");

    const shown = await screen.findByText(/already connected to a workspace/i);
    expect(shown).toBeInTheDocument();
    // It says a workspace, never which one, and never whether one exists.
    expect(shown.textContent).not.toMatch(/org-|organization named/i);
  });
});

describe("neither leg", () => {
  it("explains a directly-opened callback instead of looking broken", async () => {
    renderCallback("");
    expect(
      await screen.findByText(/opened without the details GitHub sends/i)
    ).toBeInTheDocument();
    expect(mockCompleteInstallSetup).not.toHaveBeenCalled();
    expect(mockCompleteUserAuthorization).not.toHaveBeenCalled();
  });

  it("offers a way back", async () => {
    const user = userEvent.setup();
    renderCallback("");
    await user.click(
      await screen.findByRole("button", { name: /Back to GitHub Checks/ })
    );
    expect(mockNavigate).toHaveBeenCalledWith("/settings/integrations/github");
  });
});
